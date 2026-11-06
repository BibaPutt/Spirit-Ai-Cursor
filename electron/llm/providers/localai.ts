import { MAX_TOKENS } from '../models';
import { getLocalAiConfig, getChipsLocalAiConfig } from '../../store/settings';
import { estimateTokens, truncateForBudget } from '../../memory/sessions';
import type { Message } from '../prompt';
import type { ProviderSettings } from '../../types';
import { classifyError } from './error-classify';
import {
  HTTP_HEADERS_BASE,
  ProviderHttpError,
  type ProviderClient,
} from './types';
import { parseOpenAIStream } from './openai-stream';
import { withProgressTimeout } from './round-retry';

// Own ceilings under the router fuse (600s): a half-open server must fail
// the attempt, never the run. Generous on purpose — local model loads take
// a while and thinking models pause long between tokens. Stall = silent
// mid-stream; any token or thinking delta resets it (openai-stream.ts).
const LOCALAI_FETCH_TIMEOUT_MS = 300_000;
const LOCALAI_STALL_TIMEOUT_MS = 300_000;

// Local AI provider: any OpenAI-compatible server reachable over HTTP —
// LM Studio, llama.cpp, Ollama (its /v1 endpoint), Jan, vLLM, text-gen-webui,
// etc. All of these speak the OpenAI wire format (`/v1/chat/completions`),
// so one client serves every server. The base URL, selected model, and
// capability toggles come from the stored localai settings; the API key is
// optional (most local servers need none).
//
// Unlike the cloud providers this client is stateful-by-settings: `pickModel`
// and `supports` read the current stored config so model + capability
// choices made in Settings are honoured at query time.
//
// Two instances exist: `localaiProvider` reads the main providers slot
// (getLocalAiConfig) and `localaiChipsProvider` reads the independent chips
// slot (getChipsLocalAiConfig). Both are built by makeLocalAiProvider with
// the config source injected so the chips chain can target a different local
// server than the main answer chain.

// Normalize a user-supplied base URL to the OpenAI-compatible prefix:
//   http://localhost:1234        -> http://localhost:1234/v1
//   http://localhost:1234/v1     -> http://localhost:1234/v1
//   http://localhost:1234/v1/    -> http://localhost:1234/v1
//   http://localhost:1234/models -> http://localhost:1234/v1
export function resolveOpenAIEndpoint(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (/\/models$/.test(url)) url = url.replace(/\/models$/, '');
  if (!/\/v1$/.test(url)) url += '/v1';
  return url;
}

// Warn-once for unreachable local server: fetch/timeout errors repeat every
// turn without this. Module-level Set = once per session per provider id.
const localDownWarned = new Set<string>();

export function resetLocalDownWarningsForTests(): void {
  localDownWarned.clear();
}

// True for fetch/timeout/abort-style failures (server down, not HTTP status).
export function isLocalDownError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /fetch failed|failed to fetch|networkerror|network error|enotfound|econnrefused|econnreset|etimedout|socket hang up|timeout|aborted|abort|unable to connect|could not connect|could not reach|ECONN|ERR_/i.test(
    msg,
  );
}

// Log the unreachable warning once per provider id. Returns true if logged.
export function warnLocalDownOnce(providerId = 'localai', err?: unknown): boolean {
  if (localDownWarned.has(providerId)) return false;
  localDownWarned.add(providerId);
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err ?? '');
  console.warn(`[${providerId}] server unreachable (${detail}); will keep trying next provider`);
  return true;
}

function makeLocalAiProvider(getCfg: () => ProviderSettings): ProviderClient {
  return {
    id: 'localai',
    displayName: 'Local AI',

    pickModel(req) {
      // A single local model serves both tiers — the stored selection (or the
      // first auto-detected model) is used regardless of fast/capable. The
      // user explicitly picked it in Settings; tier gymnastics make no sense
      // for a server that hosts whatever the user loaded.
      void req;
      const cfg = getCfg();
      const model = cfg.model?.trim();
      if (model) return model;
      const first = cfg.availableModels?.[0];
      return first?.id ?? '';
    },

    supports(cap) {
      // Capability toggles live in the stored localai settings. They are
      // auto-set from the selected model's server-reported metadata when the
      // server publishes it (e.g. llama.cpp's capabilities.vision); otherwise
      // the user controls them manually in Settings.
      const cfg = getCfg();
      switch (cap) {
        case 'vision':
          return cfg.vision === true;
        case 'tools':
          return cfg.tools === true;
        case 'web':
          // Local models have no grounded web search; only enabled if the user
          // explicitly turned the toggle on (which will route web-style
          // requests at the model, not through a :online suffix).
          return cfg.web === true;
        default:
          return false;
      }
    },

    async runRound(model, messages, apiKey, tools, signal, onChunk, onReasoning) {
      const cfg = getCfg();
      const baseUrl = cfg.baseUrl?.trim();
      if (!baseUrl) {
        throw new Error(
          'Local AI server is not configured. Set a server address in /settings → Providers → Local AI.',
        );
      }
      const endpoint = resolveOpenAIEndpoint(baseUrl);

      // Respect the server's context window. llama.cpp rejects requests that
      // exceed its n_ctx ("request (N tokens) exceeds the available context
      // size"); the global maxContextTokens budget (8000 default) is far
      // larger than a typical local server's window, so the pre-router
      // truncation never kicks in. Budget = server context minus room for the
      // response (MAX_TOKENS) plus a safety margin for tool schemas/overhead.
      // When the server doesn't report a context (LM Studio, Ollama) we fall
      // back to the global budget and stay out of the way.
      let effectiveMessages = messages;
      const serverContext = cfg.contextLength;
      if (typeof serverContext === 'number' && serverContext > 0) {
        const reserve = MAX_TOKENS + 1024;
        const budget = Math.max(2000, serverContext - reserve);
        effectiveMessages = truncateForBudget(messages, budget);
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...HTTP_HEADERS_BASE,
      };
      const key = (apiKey ?? '').trim();
      if (key) headers.Authorization = `Bearer ${key}`;

      // Text-only models (vision toggle off) cannot read image blocks at all —
      // a local server rejects them ("image input is not supported ... provide
      // the mmproj" is llama.cpp's exact refusal). Strip any screenshot
      // image_url blocks so the round survives even when a caller attached one
      // without checking capability (router fallback, see_screen mid-run,
      // chips slot). Mirrors opencode.ts buildParts and works for every path.
      const stripVisionBlocks = (msgs: Message[]): Message[] => {
        if (cfg.vision === true) return msgs;
        return msgs.map((m) => {
          if (m.role === 'user' && Array.isArray(m.content)) {
            const text = m.content.filter((b) => b.type !== 'image_url');
            return { ...m, content: text.length > 0 ? text : '' };
          }
          return m;
        });
      };

      // Send one payload, optionally re-truncating to an ESTIMATE budget. The
      // tokenizer on disk is denser than the 4-chars-per-token estimate, so an
      // estimate budget can still let a request through that the server's real
      // context window rejects. On an overflow the server's own numbers are
      // returned for self-calibration instead of throwing immediately.
      const send = async (msgs: Message[], estimateBudget?: number, degrade = false) => {
        // Own SILENCE ceiling under the router fuse: a half-open server
        // (accepts, never replies) must fail the attempt, not the run — but a
        // long answer that keeps streaming must never be cut for total
        // duration. Model load counts as silence; every byte re-arms it.
        const bound = withProgressTimeout(signal, LOCALAI_FETCH_TIMEOUT_MS);
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
          const use = stripVisionBlocks(
            estimateBudget !== undefined ? truncateForBudget(msgs, estimateBudget) : msgs,
          );
          const estimate = use.reduce((s, m) => s + estimateTokens(m), 0);
          const body: Record<string, unknown> = {
            model,
            messages: use,
            max_tokens: degrade ? MAX_TOKENS * 2 : MAX_TOKENS,
            stream: true,
          };
          if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = 'auto';
          }
          if ((tools && tools.length > 0) || degrade) {
            body.reasoning_effort = 'none';
          }
          if (degrade) {
            console.warn('[localai] degrading round: reasoning off, max_tokens ' + (MAX_TOKENS * 2));
          }
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            signal: sig ?? signal ?? undefined,
            headers,
            body: JSON.stringify(body),
          });
        bound.touch();
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const m = text.match(
            /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/,
          );
          if (m) {
            return {
              retry: true as const,
              estimate,
              realN: Number(m[1]),
              serverM: Number(m[2]),
              errorText: text,
            };
          }
          throw new ProviderHttpError(
            `Local AI ${res.status}: ${text.slice(0, 240) || res.statusText}`,
            res.status,
            'localai',
          );
        }
        if (!res.body) throw new Error('Local AI server returned no body');
        return {
          retry: false as const,
          stream: await parseOpenAIStream(
            res.body,
            touchChunk,
            sig ?? signal ?? undefined,
            onReasoning ? touchReasoning : undefined,
            LOCALAI_STALL_TIMEOUT_MS,
          ),
          estimate,
        };
        } finally {
          bound.cancel();
        }
      };

      // Self-calibrating overflow retry: llama.cpp reports REAL token counts,
      // so one rejected request yields the exact estimate→real ratio. Re-fit
      // the estimate budget so the REAL payload (minus the response
      // reservation) fits the server window, then retry exactly once. The
      // estimate is corrected from the server's own counters — no tokenizer
      // assumptions, works for any local model regardless of how dense.
      try {
        const first = await send(effectiveMessages);
        if (first.retry) {
          const targetReal = Math.max(2000, first.serverM - MAX_TOKENS - 1024);
          const ratio = first.realN / Math.max(1, first.estimate);
          const estimateTarget = Math.max(500, Math.floor(targetReal / ratio));
          console.warn(
            `[localai] server context overflow (${first.realN} real tokens > ${first.serverM} n_ctx); ` +
              `estimate undercounts ${ratio.toFixed(2)}x — re-truncating to ~${estimateTarget} est tokens and retrying`,
          );
          const second = await send(messages, estimateTarget);
          if (second.retry) {
            throw new ProviderHttpError(
              `Local AI 413: request still exceeds the server context window after self-calibration (${first.errorText.slice(0, 240)})`,
              413,
              'localai',
            );
          }
          return second.stream;
        }
        return first.stream;
      } catch (err) {
        // Thinking-phase budget overflow: the model spent its whole output
        // budget on chain-of-thought and was cut off before producing
        // anything usable. Retry once with thinking disabled and a doubled
        // output cap instead of surfacing a hard failure.
        const { code } = classifyError(err, 'Local AI');
        if (code === 'thinking-limit') {
          console.warn(
            '[localai] thinking-phase budget overflow; retrying once with reasoning off + larger max_tokens',
          );
          const degraded = await send(effectiveMessages, undefined, true);
          if (degraded.retry) {
            throw new ProviderHttpError(
              'Local AI 413: request still exceeds the server context window on the degraded retry',
              413,
              'localai',
            );
          }
          return degraded.stream;
        }
        if (isLocalDownError(err)) warnLocalDownOnce('localai', err);
        throw err;
      }
    },
  };
}

export const localaiProvider = makeLocalAiProvider(getLocalAiConfig);
export const localaiChipsProvider = makeLocalAiProvider(getChipsLocalAiConfig);
