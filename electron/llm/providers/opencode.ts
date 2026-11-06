import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { MAX_TOKENS } from '../models';
import { getOpencodeConfig } from '../../store/settings';
import type { Message } from '../prompt';
import {
  HTTP_HEADERS_BASE,
  ProviderHttpError,
  type ProviderClient,
  type ProviderRoundResult,
  type ProviderToolCall,
} from './types';
import type { ToolDeclaration } from '../tools';
import { parseOpenAIStream } from './openai-stream';
import {
  isTerminalQuotaError,
  parseRetryAfterMs,
  setRoundRetryWaitForTests,
  withProgressTimeout,
} from './round-retry';

// Opencode provider: targets the local opencode bridge
// (default http://127.0.0.1:4096), which serves models behind an
// OpenAI-compatible wire format (`GET /v1/models`,
// `POST /v1/chat/completions`, streaming SSE) relayed to opencode's zen
// tier. Same shape as the Local AI client: base URL + selected model +
// capability toggles all come from the stored opencode settings, no API key.
//
// Notes vs the old session-API client it replaces:
//   - The proxy relays `tools`/`tool_choice` upstream (and injects stub
//     bash/read tools the free tier requires), so `supports('tools')` follows
//     the stored toggle instead of always false.
//   - Vision is per-toggle: upstream support varies by free model, and the
//     proxy drops what the model can't take — screenshots ride only when the
//     user enables vision in Settings.
//   - The proxy forces SSE upstream and folds it back when streaming is off;
//     we always stream, so rounds behave like every other provider here.

const DEFAULT_BASE_URL = 'http://127.0.0.1:4096';

// Upstream statuses worth another attempt through the other endpoint shape.
const RETRY_VIA_RESPONSES = new Set([401, 403, 404, 405, 429, 500, 502, 503, 504]);

// The free upstream flickers per call (observed: same model 200 → 401 within
// seconds on both /v1/chat/completions and /v1/responses). Hermes rides
// through because the opencode CLI retries — so do we: same-shape retry
// after a short pause, then one cross-shape attempt, then give up honestly.
const RETRY_DELAY_MS = 2000;

// Upper bounds per attempt (the router fuse is the outer net; these are the
// provider's own so a half-open server can never hang a round forever).
// Stall = silent mid-stream; fetch = no response headers at all.
const OPENCODE_STALL_TIMEOUT_MS = 300_000;
const OPENCODE_FETCH_TIMEOUT_MS = 400_000;

// Warn-once for unreachable opencode bridge: module-level Set, once per session.
const opencodeDownWarned = new Set<string>();

// Free/public-tier quota exhaustion is TERMINAL, not transient. opencode2api
// answers unauthenticated requests from the shared public tier; once that
// quota is spent the upstream returns 429 FreeUsageLimitError for every call
// until the window resets (minutes). Retrying same-shape, cross-shape, or
// through the router's round retry only burns ~45s per attempt for the same
// error. Detect it, fail fast, and refuse to touch the endpoint again for a
// cooldown so the next question skips straight to another provider.
const QUOTA_COOLDOWN_MS = 10 * 60_000;
let quotaBlockedUntil = 0;

export function isOpencodeQuotaBlocked(now = Date.now()): boolean {
  return now < quotaBlockedUntil;
}

export function resetOpencodeQuotaBlockForTests(): void {
  quotaBlockedUntil = 0;
}

function isQuotaExhausted(status: number, body: string): boolean {
  if (status !== 429) return false;
  return /FreeUsageLimitError|free usage limit|subscribe to OpenCode Go|insufficient_quota|quota (?:exceeded|exhausted)/i.test(
    body,
  );
}

const QUOTA_MESSAGE =
  'Opencode free tier quota is exhausted. It is the shared public tier — add an OpenCode API key in /settings, or start your own opencode server and point the Opencode base URL at it.';

// opencode CLI transport (the free-tier path that actually works)
//
// opencode2api only reaches the shared *public* tier when it gets no key, and
// that tier is throttled per IP. The opencode CLI, on the other hand, is
// already authenticated on this machine (it is what powers `opencode` chats)
// and reaches the zen free models directly. So when the HTTP endpoint reports
// a spent quota we shell out to `opencode run --format json` and stream its
// text back. No key, no proxy, no 9router.

const CLI_TIMEOUT_MS = 180_000;

function resolveOpencodeBin(): string | null {
  const override = process.env.SPIRIT_OPENCODE_BIN?.trim();
  if (override && existsSync(override)) return override;
  const appData = process.env.APPDATA;
  if (appData) {
    const exe = join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (existsSync(exe)) return exe;
  }
  // Fall back to PATH resolution (caller uses shell: true for this case).
  return null;
}

// CLI transport is the default. SPIRIT_OPENCODE_CLI=0 restores the old
// HTTP-only behaviour; tests never spawn a real CLI process.
export function isOpencodeCliEnabled(): boolean {
  return process.env.SPIRIT_OPENCODE_CLI !== '0' && !process.env.VITEST;
}

// The CLI expects provider/model, while Spirit stores whatever id the user
// picked. No hardcoded catalog: ask the installed CLI what it actually has
// (`opencode models`) and match the selection against it.
let cliModelCache: string[] | null = null;

function readCliModels(): Promise<string[]> {
  if (cliModelCache) return Promise.resolve(cliModelCache);
  const bin = resolveOpencodeBin();
  return new Promise((resolvePromise) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin ?? 'opencode', ['models'], {
        windowsHide: true,
        shell: bin === null,
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch {
      return resolvePromise([]);
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (b: string) => {
      out += b;
    });
    child.on('error', () => resolvePromise([]));
    child.on('close', () => {
      const list = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[^\s/]+\/.+/.test(l));
      if (list.length > 0) cliModelCache = list;
      resolvePromise(list);
    });
  });
}

// Resolve the user's selected id to a provider/model string the CLI accepts.
// Exact id wins; otherwise match the trailing segment (with or without the
// -free suffix). No model names are baked in.
export async function resolveCliModel(model: string): Promise<string> {
  const id = (model ?? '').trim();
  const available = await readCliModels();
  if (id.includes('/')) {
    return available.includes(id) || available.length === 0 ? id : id;
  }
  if (id) {
    const exact = available.find((m) => m === id);
    if (exact) return exact;
    const tail = available.filter((m) => {
      const [, name] = m.split('/');
      return name === id || name === `${id}-free`;
    });
    if (tail.length > 0) return tail[0];
  }
  // Nothing to go on: use the first model the CLI reports (its default).
  return available[0] ?? id;
}

// Flatten Spirit's message array into one prompt. The tail is kept (recent
// turns matter most) while the system prompt survives at the front.
export function flattenMessagesForCli(messages: Message[], maxChars = 24_000): string {
  const sys = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOfContent(m.content))
    .join('\n')
    .trim();
  const rest = messages.filter((m) => m.role !== 'system');
  const lines = rest.map((m) => {
    const who =
      m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
    return `${who}: ${textOfContent(m.content)}`;
  });
  let body = lines.join('\n\n');
  if (body.length > maxChars) body = body.slice(body.length - maxChars);
  return sys ? `[System instructions]\n${sys}\n\n[Conversation]\n${body}` : body;
}

function textOfContent(content: Message['content'] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => ('text' in b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .join('');
}

type CliEvent = {
  type?: string;
  part?: { type?: string; text?: string; reason?: string };
};

// Managed `opencode serve` sidecar.
//
// Spawning `opencode run` per round pays the CLI bootstrap (config, plugins,
// permission setup) every time. A single headless server keeps that warm, so
// rounds reuse one process via `--attach`. Started lazily on first session and
// torn down with the app.

let serverProc: ReturnType<typeof spawn> | null = null;
let serverUrl: string | null = null;
let serverStarting: Promise<string | null> | null = null;

const OPCODE_SERVER_BOOT_MS = 20_000;
const OPCODE_SERVER_LINE =
  /opencode server listening on (http:\/\/[^\s]+)/i;

function killServer(): void {
  if (!serverProc) return;
  try {
    serverProc.kill();
  } catch {
    /* already gone */
  }
  serverProc = null;
  serverUrl = null;
  serverStarting = null;
}

if (!process.env.VITEST) {
  process.once('exit', killServer);
  process.once('SIGINT', killServer);
  process.once('SIGTERM', killServer);
}

function startServer(): Promise<string | null> {
  const explicit = process.env.SPIRIT_OPENCODE_SERVER_URL?.trim();
  if (explicit) {
    serverUrl = explicit.replace(/\/+$/, '');
    return Promise.resolve(serverUrl);
  }
  const bin = resolveOpencodeBin();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (url: string | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(url);
    };
    // `--port 0` means "default port" (4096) here, which collides with the
    // opencode2api bridge, so reserve a free port ourselves first.
    pickFreePort().then((port) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          bin ?? 'opencode',
          ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
          { windowsHide: true, shell: bin === null, env: { ...process.env, NO_COLOR: '1' } },
        );
      } catch {
        return finish(null);
      }
      serverProc = child;
      const timer = setTimeout(() => {
        killServer();
        finish(null);
      }, OPCODE_SERVER_BOOT_MS);
      const scan = (buf: string): void => {
        const m = OPCODE_SERVER_LINE.exec(buf);
        if (m) {
          clearTimeout(timer);
          serverUrl = m[1].replace(/\/+$/, '');
          console.log(`[opencode] managed server at ${serverUrl}`);
          finish(serverUrl);
        }
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', scan);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', scan);
      child.on('exit', () => {
        clearTimeout(timer);
        if (serverProc === child) {
          serverProc = null;
          serverUrl = null;
          serverStarting = null;
        }
        finish(null);
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
    });
  });
}

function pickFreePort(): Promise<number> {
  return new Promise((resolvePromise) => {
    try {
      const srv = createServer();
      srv.once('error', () => resolvePromise(0));
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolvePromise(port));
      });
    } catch {
      resolvePromise(0);
    }
  });
}

export async function ensureOpencodeServer(): Promise<string | null> {
  if (serverUrl) return serverUrl;
  if (process.env.SPIRIT_OPENCODE_SERVER === '0') return null;
  if (!serverStarting) serverStarting = startServer();
  const url = await serverStarting;
  if (!url) serverStarting = null;
  return url;
}

export function stopOpencodeServerForTests(): void {
  killServer();
}

// Server transport: drive a running (or managed) `opencode serve` directly.
// One POST per round, the server keeps the auth + model bootstrap warm, and it
// takes Spirit's system prompt as a first-class field instead of inlining it.

function splitProviderModel(resolved: string): { providerID: string; modelID: string } {
  const slash = resolved.indexOf('/');
  if (slash <= 0) return { providerID: 'opencode', modelID: resolved };
  return { providerID: resolved.slice(0, slash), modelID: resolved.slice(slash + 1) };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), CLI_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode server ${res.status}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function runOpencodeServerRound(
  server: string,
  model: string,
  messages: Message[],
  signal: AbortSignal | undefined,
  onChunk: (text: string) => void,
  workspace?: string,
): Promise<import('./types').ProviderRoundResult> {
  const { providerID, modelID } = splitProviderModel(await resolveCliModel(model));
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOfContent(m.content))
    .join('\n')
    .trim();
  const conversation = messages.filter((m) => m.role !== 'system');
  const promptText = flattenMessagesForCli(conversation, 24_000);

  const created = await fetchJson(
    `${server}/api/session`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: { id: modelID, providerID },
        location: { directory: workspace ?? process.cwd() },
      }),
    },
    signal,
  );
  const sessionID = (created.data as { id?: string } | undefined)?.id;
  if (!sessionID) throw new Error('opencode server did not return a session id');

  const reply = await fetchJson(
    `${server}/session/${encodeURIComponent(sessionID)}/message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: { providerID, modelID },
        ...(system ? { system } : {}),
        parts: [{ type: 'text', text: promptText }],
      }),
    },
    signal,
  );

  const parts = Array.isArray(reply.parts) ? (reply.parts as Array<{ type?: string; text?: string }>) : [];
  const contentText = parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim();
  if (!contentText) throw new Error('opencode server returned no text');

  onChunk(contentText);
  const finish = (reply.info as { finish?: string } | undefined)?.finish ?? 'stop';
  return { contentText, toolCalls: [], finishReason: finish };
}

async function runOpencodeCliRound(
  model: string,
  messages: Message[],
  signal: AbortSignal | undefined,
  onChunk: (text: string) => void,
  workspace?: string,
): Promise<import('./types').ProviderRoundResult> {
  const bin = resolveOpencodeBin();
  const cliModel = await resolveCliModel(model);
  const server = await ensureOpencodeServer().catch(() => null);
  const args = [
    'run',
    '--format',
    'json',
    '--model',
    cliModel,
    // Attached to the warm server: no --dir (that path is server-relative).
    ...(server ? ['--attach', server] : workspace ? ['--dir', workspace] : []),
  ];
  // The prompt rides on stdin. Passing it as argv blows past the Windows
  // 32k command-line limit (spawn ENAMETOOLONG) as soon as the real
  // system prompt + history is sent.
  const prompt = flattenMessagesForCli(messages);

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(bin ?? 'opencode', args, {
      windowsHide: true,
      shell: bin === null,
      env: { ...process.env, NO_COLOR: '1' },
    });

    try {
      child.stdin?.on('error', () => undefined);
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* the close handler reports the real failure */
    }

    let stdout = '';
    let stderr = '';
    let emitted = '';
    let settled = false;
    let finishReason: string | null = null;
    let sawText = false;

    const kill = (): void => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      kill();
      done(new Error('Opencode CLI timed out'));
    }, CLI_TIMEOUT_MS);
    const onAbort = (): void => {
      kill();
      done(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        reject(err);
        return;
      }
      const contentText = emitted.trim();
      if (!contentText) {
        reject(
          new Error(
            `Opencode CLI returned no text${stderr ? `: ${stderr.slice(-300)}` : ''}`,
          ),
        );
        return;
      }
      resolvePromise({ contentText, toolCalls: [], finishReason });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (buf: string) => {
      stdout += buf;
      let idx: number;
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line) continue;
        let evt: CliEvent;
        try {
          evt = JSON.parse(line) as CliEvent;
        } catch {
          continue;
        }
        if (evt.type === 'text' && typeof evt.part?.text === 'string') {
          const full = evt.part.text;
          if (full.length > emitted.length && full.startsWith(emitted)) {
            onChunk(full.slice(emitted.length));
            emitted = full;
          } else if (!emitted.endsWith(full)) {
            emitted += full;
            onChunk(full);
          }
          sawText = true;
        } else if (evt.type === 'step_finish') {
          finishReason = evt.part?.reason ?? 'stop';
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (buf: string) => {
      stderr += buf;
    });
    child.on('error', (err) => done(err instanceof Error ? err : new Error(String(err))));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && !sawText) {
        done(new Error(`Opencode CLI exited ${code}${stderr ? `: ${stderr.slice(-300)}` : ''}`));
        return;
      }
      done();
    });
  });
}


export function resetOpencodeDownWarningsForTests(): void {
  opencodeDownWarned.clear();
}

export function isOpencodeDownError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /fetch failed|failed to fetch|networkerror|network error|enotfound|econnrefused|econnreset|etimedout|socket hang up|timeout|aborted|abort|unable to connect|could not connect|could not reach|ECONN|ERR_/i.test(
    msg,
  );
}

export function warnOpencodeDownOnce(err?: unknown): boolean {
  if (opencodeDownWarned.has('opencode')) return false;
  opencodeDownWarned.add('opencode');
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err ?? '');
  console.warn(`[opencode] server unreachable (${detail}); will keep trying next provider`);
  return true;
}

// Round retry lives in round-retry.ts (universal: every provider, any
// failure, 5 attempts, backoff to 60s). This file keeps only the
// opencode-specific down warning + test aliases.
export function setOpencodeTimeoutRetryForTests(ms: number | null): void {
  setRoundRetryWaitForTests(ms);
}

export function isTimeoutAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /timeout|timed out|aborted|aborterror/i.test(`${name} ${msg}`);
}

// Tests shorten the retry pause (mirrors setAppLessonsStorePathForTests).
let retryDelayBaseMs = RETRY_DELAY_MS;

export function setOpencodeRetryDelayForTests(ms: number | null): void {
  retryDelayBaseMs = ms ?? RETRY_DELAY_MS;
}

// Hermes/opencode CLI identifies each conversation upstream with its own
// x-opencode-session id. Spirit sent none, so the proxy mapped ALL Spirit
// traffic onto one shared global fallback session — one flagged burst poisons
// every later turn. A stable per-launch id gives Spirit its own lane like
// every Hermes conversation has. Harmless against plain OpenAI servers
// (unknown x- headers are ignored).
const CLIENT_SESSION = randomUUID();

function retryDelayMs(): number {
  // Full jitter: base..2*base. Tests set base 0 for instant retries.
  return retryDelayBaseMs + Math.floor(Math.random() * retryDelayBaseMs);
}

function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// Normalize a user-supplied base URL to the OpenAI-compatible prefix:
//   http://127.0.0.1:4096        -> http://127.0.0.1:4096/v1
//   http://127.0.0.1:4096/v1     -> http://127.0.0.1:4096/v1
//   http://127.0.0.1:4096/v1/    -> http://127.0.0.1:4096/v1
//   http://127.0.0.1:4096/models -> http://127.0.0.1:4096/v1
export function resolveOpencodeEndpoint(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (/\/models$/.test(url)) url = url.replace(/\/models$/, '');
  if (!/\/v1$/.test(url)) url += '/v1';
  return url;
}

export const opencodeProvider: ProviderClient = {
  id: 'opencode',
  displayName: 'Opencode',

  pickModel() {
    const cfg = getOpencodeConfig();
    const model = cfg.model?.trim();
    if (model) return model;
    const first = cfg.availableModels?.[0];
    return first?.id ?? '';
  },

  supports(cap) {
    const cfg = getOpencodeConfig();
    switch (cap) {
      case 'vision':
        return cfg.vision === true;
      case 'tools':
        return cfg.tools === true;
      case 'web':
        return cfg.web === true;
      default:
        return false;
    }
  },

  async runRound(model, messages, apiKey, tools, signal, onChunk, onReasoning) {
    const cfg = getOpencodeConfig();
    const endpoint = resolveOpencodeEndpoint(cfg.baseUrl?.trim() || DEFAULT_BASE_URL);

    // Vision off: free vision support varies by upstream model and a stray
    // image block can fail the round — strip screenshot blocks so text-only
    // rounds always survive (mirrors the Local AI client).
    const use: Message[] =
      cfg.vision === true
        ? messages
        : messages.map((m) => {
            if (m.role === 'user' && Array.isArray(m.content)) {
              const text = m.content.filter((b) => b.type !== 'image_url');
              return { ...m, content: text.length > 0 ? text : '' };
            }
            return m;
          });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Own upstream lane (see CLIENT_SESSION): the proxy pins this to a
      // stable zen session instead of the shared global fallback one.
      'x-opencode-session': CLIENT_SESSION,
      ...HTTP_HEADERS_BASE,
    };

    // Transport order, fastest first:
    //   1. opencode server  — warm process, ~1-6s per round
    //   2. opencode CLI     — stdin prompt, ~15-28s per round, still works
    //   3. HTTP bridge      — opencode2api, only if the above are unavailable
    if (isOpencodeCliEnabled()) {
      const server = await ensureOpencodeServer().catch(() => null);
      if (server) {
        try {
          return await runOpencodeServerRound(server, model, use, signal, onChunk);
        } catch (srvErr) {
          if (signal?.aborted) throw srvErr;
          console.warn(
            `[opencode] server transport failed (${srvErr instanceof Error ? srvErr.message : String(srvErr)}); trying CLI`,
          );
        }
      }
      try {
        return await runOpencodeCliRound(model, use, signal, onChunk);
      } catch (cliErr) {
        if (signal?.aborted) throw cliErr;
        console.warn(
          `[opencode] CLI transport failed (${cliErr instanceof Error ? cliErr.message : String(cliErr)}); trying HTTP endpoint`,
        );
      }
    }

    const key = (apiKey ?? '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    const chatBody: Record<string, unknown> = {
      model,
      messages: use,
      max_tokens: MAX_TOKENS,
      stream: true,
    };
    if (tools && tools.length > 0) {
      chatBody.tools = tools;
      chatBody.tool_choice = 'auto';
    }

    const postChat = async (sig?: AbortSignal): Promise<Response> =>
      fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        signal: sig ?? signal ?? undefined,
        headers,
        body: JSON.stringify(chatBody),
      });

    const doRound = async (): Promise<import('./types').ProviderRoundResult> => {
      // Own SILENCE ceiling on top of the router fuse: a half-open proxy
      // (headers never arrive) must fail the attempt, not the run — while a
      // long answer that keeps streaming is never cut off for total duration.
      // Every byte and every reasoning delta re-arms it.
      const bound = withProgressTimeout(signal, OPENCODE_FETCH_TIMEOUT_MS);
      const sig = bound.signal;
      const touchChunk = (text: string): void => {
        bound.touch();
        onChunk(text);
      };
      const touchReasoning = (delta: string): void => {
        bound.touch();
        onReasoning?.(delta);
      };
      try {
        if (isOpencodeQuotaBlocked()) {
          throw new ProviderHttpError(QUOTA_MESSAGE, 429, 'opencode');
        }
        let chatRes = await postChat(sig ?? undefined);
        bound.touch();
        if (!chatRes.ok) {
          // Read the error body once: it is the only way to tell a transient
          // 429 (retry) from a spent free-tier quota (terminal). Every retry
          // below issues a fresh request, so consuming this body is safe.
          const bodyText = await chatRes.text().catch(() => '');
          if (isQuotaExhausted(chatRes.status, bodyText)) {
            quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
            console.warn('[opencode] free tier quota exhausted; skipping opencode for cooldown');
            throw new ProviderHttpError(QUOTA_MESSAGE, chatRes.status, 'opencode');
          }
          if (!RETRY_VIA_RESPONSES.has(chatRes.status)) {
            throw new ProviderHttpError(
              `Opencode ${chatRes.status}: ${bodyText.slice(0, 240) || chatRes.statusText}`,
              chatRes.status,
              'opencode',
            );
          }
        }
        if (!chatRes.ok && RETRY_VIA_RESPONSES.has(chatRes.status)) {
          // Same-shape retry after a pause: the upstream gate is transient and a
          // second call seconds later routinely succeeds (verified live). Honour
          // the server's Retry-After when it sends one.
          const wait = parseRetryAfterMs(chatRes.headers) ?? retryDelayMs();
          console.warn(
            `[opencode] chat/completions -> ${chatRes.status}; retrying same shape in ${wait}ms`,
          );
          await sleepOrAbort(wait, signal);
          chatRes = await postChat(sig ?? undefined);
          bound.touch();
          if (!chatRes.ok) {
            const retryBody = await chatRes.text().catch(() => '');
            if (isQuotaExhausted(chatRes.status, retryBody)) {
              quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
              console.warn('[opencode] free tier quota exhausted; skipping opencode for cooldown');
              throw new ProviderHttpError(QUOTA_MESSAGE, chatRes.status, 'opencode');
            }
            if (!RETRY_VIA_RESPONSES.has(chatRes.status)) {
              throw new ProviderHttpError(
                `Opencode ${chatRes.status}: ${retryBody.slice(0, 240) || chatRes.statusText}`,
                chatRes.status,
                'opencode',
              );
            }
          }
        }
        if (chatRes.ok) {
          if (!chatRes.body) throw new Error('Opencode server returned no body');
          return await parseOpenAIStream(
            chatRes.body,
            touchChunk,
            sig ?? signal ?? undefined,
            onReasoning ? touchReasoning : undefined,
            OPENCODE_STALL_TIMEOUT_MS,
          );
        }
        if (!RETRY_VIA_RESPONSES.has(chatRes.status)) {
          const text = await chatRes.text().catch(() => '');
          throw new ProviderHttpError(
            `Opencode ${chatRes.status}: ${text.slice(0, 240) || chatRes.statusText}`,
            chatRes.status,
            'opencode',
          );
        }
        // The free upstream accepts some models on /v1/responses while rejecting
        // the same id on /v1/chat/completions (observed 401s) — and vice versa.
        // One translation attempt, then surface the error honestly.
        await chatRes.body?.cancel().catch(() => undefined);
        console.warn(
          `[opencode] chat/completions -> ${chatRes.status}; retrying once via /v1/responses`,
        );
        return runResponsesRound(endpoint, model, use, tools, headers, sig ?? signal, touchChunk);
      } finally {
        bound.cancel();
      }
    };

    try {
      return await doRound();
    } catch (err) {
      if (isOpencodeDownError(err)) warnOpencodeDownOnce(err);
      throw err;
    }
  },
};

// /v1/responses fallback: chat-shaped request translated to the responses
// shape, SSE folded back into text + OpenAI-style tool calls.

function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if ('text' in b && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function toResponsesBody(
  model: string,
  messages: Message[],
  tools: ToolDeclaration[] | undefined,
): Record<string, unknown> {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const m of messages) {
    const text = messageText(m.content);
    if (m.role === 'system') {
      instructions.push(text);
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: (m as { tool_call_id?: string }).tool_call_id ?? '',
        output: text,
      });
    } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
    } else {
      input.push({
        type: 'message',
        role: m.role,
        content: [{ type: 'input_text', text }],
      });
    }
  }
  const body: Record<string, unknown> = {
    model,
    input: input.length > 0 ? input : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }],
    stream: true,
  };
  if (instructions.length > 0) body.instructions = instructions.join('\n');
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

type ResponsesCall = { callId: string; name: string; args: string };

async function runResponsesRound(
  endpoint: string,
  model: string,
  messages: Message[],
  tools: ToolDeclaration[] | undefined,
  headers: Record<string, string>,
  signal: AbortSignal,
  onChunk: (text: string) => void,
): Promise<ProviderRoundResult> {
  const postResponses = async (): Promise<Response> =>
    fetch(`${endpoint}/responses`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(toResponsesBody(model, messages, tools)),
    });

  let res = await postResponses();
  if (!res.ok && RETRY_VIA_RESPONSES.has(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    console.warn(
      `[opencode] responses -> ${res.status}; retrying same shape in ${RETRY_DELAY_MS}ms`,
    );
    await sleepOrAbort(retryDelayMs(), signal);
    res = await postResponses();
  }
  if (!res.ok || !res.body) {
    const text = !res.ok ? await res.text().catch(() => '') : '';
    throw new ProviderHttpError(
      `Opencode ${res.status}: ${text.slice(0, 240) || res.statusText || 'empty responses body'}`,
      res.status,
      'opencode',
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const calls = new Map<string, ResponsesCall>();
  const order: string[] = [];

  const feed = (chunk: string): void => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const etype = typeof j.type === 'string' ? j.type : '';
      if (etype === 'response.output_text.delta' && typeof j.delta === 'string') {
        text += j.delta;
        onChunk(j.delta);
      } else if (etype === 'response.output_item.added') {
        const item = (j.item ?? {}) as Record<string, unknown>;
        if (item.type === 'function_call') {
          const key = (item.call_id as string) || (item.id as string) || `call_${order.length}`;
          if (!calls.has(key)) {
            calls.set(key, { callId: key, name: (item.name as string) ?? '', args: '' });
            order.push(key);
          }
        }
      } else if (etype === 'response.function_call_arguments.delta' && typeof j.delta === 'string') {
        const key = (j.item_id as string) ?? order[order.length - 1];
        const e = key ? calls.get(key) : undefined;
        if (e) e.args += j.delta;
      } else if (etype === 'response.completed') {
        break;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
      if (signal?.aborted) break;
    }
    feed(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  const toolCalls: ProviderToolCall[] = [];
  for (const key of order) {
    const c = calls.get(key);
    if (!c || !c.name) continue;
    let args: Record<string, unknown> = {};
    let inputError = false;
    try {
      const parsed: unknown = JSON.parse(c.args || '{}');
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      inputError = true;
    }
    toolCalls.push({ id: c.callId, name: c.name, args, inputError: inputError || undefined });
  }
  return {
    contentText: text,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}
