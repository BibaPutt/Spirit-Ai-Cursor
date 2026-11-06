import { net } from 'electron';
import type { LocalModelInfo, ProviderId } from '../../types';
import { resolveOpenAIEndpoint } from './localai';

// Minimal "is this key valid" probe for each provider plus, when meaningful,
// a useful extra (OpenRouter credit balance). Each probe is intentionally
// the cheapest possible call — usually a GET on a list-models or account
// endpoint — and never spends real tokens beyond the listing call.

export type ProviderTestResult =
  | { ok: true; label?: string }
  | { ok: false; error: string };

export type LocalModelsResult =
  | { ok: true; models: LocalModelInfo[]; contextLength?: number }
  | { ok: false; error: string };

// Network helper using Electron's `net` module so the request goes through
// Chrome's network stack (same TLS/CA/proxy chain as the rest of the app)
// and doesn't depend on the renderer being open. `timeoutMs` guards against
// a silently hanging server — most relevant for local addresses.
function request(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  timeoutMs = 10_000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = net.request({
      url,
      method: options.method ?? 'GET',
      redirect: 'follow',
    });
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        r.setHeader(k, v);
      }
    }
    let body = '';
    let status = 0;
    const timer = setTimeout(() => {
      try {
        r.abort();
      } catch {
        /* already closed */
      }
      reject(new Error('Request timed out'));
    }, timeoutMs);
    r.on('response', (res) => {
      status = res.statusCode;
      res.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status, body });
      });
      res.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    r.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    if (options.body) r.write(options.body);
    r.end();
  });
}

// Compact "$X.XX remaining" style label from OpenRouter's /credits payload.
// `usage` is amount spent on this key so far, `limit` is the credit cap (or
// null for pay-as-you-go). When limit is null we show usage only.
function formatOpenRouterCredits(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'connected';
  const data = (payload as { data?: { total_credits?: number; total_usage?: number } }).data;
  if (!data) return 'connected';
  const credits = typeof data.total_credits === 'number' ? data.total_credits : null;
  const usage = typeof data.total_usage === 'number' ? data.total_usage : null;
  if (credits !== null && usage !== null) {
    const remaining = Math.max(0, credits - usage);
    return `$${remaining.toFixed(2)} left`;
  }
  if (usage !== null) {
    return `$${usage.toFixed(2)} used`;
  }
  return 'connected';
}

async function testOpenRouter(apiKey: string): Promise<ProviderTestResult> {
  try {
    const res = await request('https://openrouter.ai/api/v1/credits', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'Spirit',
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid API key' };
    }
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    try {
      const json = JSON.parse(res.body);
      return { ok: true, label: formatOpenRouterCredits(json) };
    } catch {
      return { ok: true, label: 'connected' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

async function testAnthropic(apiKey: string): Promise<ProviderTestResult> {
  try {
    // Anthropic has no GET endpoint that validates the key without spending
    // tokens, so we hit /v1/models which authorizes but is free.
    const res = await request('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid API key' };
    }
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, label: 'connected' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

async function testOpenAI(apiKey: string): Promise<ProviderTestResult> {
  try {
    const res = await request('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid API key' };
    }
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, label: 'connected' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

async function testGemini(apiKey: string): Promise<ProviderTestResult> {
  try {
    // Gemini takes the key as a query param, not a header.
    const res = await request(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    );
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid API key' };
    }
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, label: 'connected' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

// Probe a local OpenAI-compatible server's `GET {baseUrl}/v1/models`. This is
// the Local AI provider's connection test AND its model auto-detect in one
// call: if the server answers, the connection is good and the returned model
// list feeds the Settings dropdown. Per-model capability metadata is captured
// when the server publishes it (e.g. llama.cpp's `capabilities.vision`);
// servers that don't report capabilities (LM Studio, Ollama /v1, vLLM) return
// models with no caps, and the UI falls back to manual toggles.
//
// Also best-effort probes `GET {baseUrl}/props` for the server's context
// window (llama.cpp's n_ctx). This is non-fatal: servers that don't expose
// /props (LM Studio, Ollama) just return no contextLength and the localai
// provider falls back to the global maxContextTokens budget.
async function probeContextLength(
  rootUrl: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  try {
    const res = await request(`${rootUrl}/props`, { headers }, 3_000);
    if (res.status !== 200) return undefined;
    const json = JSON.parse(res.body) as {
      default_generation_settings?: { n_ctx?: unknown };
    };
    const nCtx = json?.default_generation_settings?.n_ctx;
    if (typeof nCtx === 'number' && Number.isFinite(nCtx) && nCtx > 0) return nCtx;
    return undefined;
  } catch {
    return undefined;
  }
}

// llama.cpp's /props lives at the server root, not under /v1. Strip the
// OpenAI-compatible prefix so probing works for any base URL shape.
function serverRoot(endpoint: string): string {
  return endpoint.replace(/\/v1$/, '');
}

export async function detectLocalModels(
  baseUrl: string,
  apiKey: string,
): Promise<LocalModelsResult> {
  const url = baseUrl.trim();
  if (!url) return { ok: false, error: 'Empty server address' };
  try {
    const endpoint = `${resolveOpenAIEndpoint(url)}/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    const key = apiKey.trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await request(endpoint, { headers }, 5_000);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Server rejected the API key (401/403).' };
    }
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status} from ${endpoint}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      return { ok: false, error: 'Server returned a non-JSON /v1/models response.' };
    }
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      return { ok: false, error: 'Server returned an unexpected /v1/models response.' };
    }
    const models: LocalModelInfo[] = data
      .map((raw): LocalModelInfo | null => {
        const m = raw as {
          id?: unknown;
          capabilities?: Record<string, unknown>;
          supports_vision?: unknown;
          vision_support?: unknown;
          multimodal?: unknown;
        };
        if (typeof m?.id !== 'string' || m.id.length === 0) return null;
        const info: LocalModelInfo = { id: m.id };
        const caps = m.capabilities ?? {};
        // Broader server metadata check: llama.cpp publishes capabilities.*,
        // some OpenAI-compatible proxies publish supports_vision /
        // vision_support / multimodal, opencode nests input.image.
        const inputCaps = (caps.input ?? {}) as
          | { image?: unknown; attachment?: unknown }
          | undefined;
        const capsVision =
          typeof caps.vision === 'boolean'
            ? caps.vision
            : typeof m.supports_vision === 'boolean'
              ? m.supports_vision
              : typeof m.vision_support === 'boolean'
                ? m.vision_support
                : typeof m.multimodal === 'boolean'
                  ? m.multimodal
                  : inputCaps && inputCaps.image === true
                    ? true
                    : undefined;
        if (capsVision !== undefined) info.vision = capsVision;
        else info.vision = isVisionModelName(m.id);
        if (typeof caps.tools === 'boolean') info.tools = caps.tools;
        else info.tools = isToolsModelName(m.id);
        if (typeof caps.web === 'boolean') info.web = caps.web;
        return info;
      })
      .filter((m): m is LocalModelInfo => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (models.length > 0) await probeModelVision(models, resolveOpenAIEndpoint(url), headers);
    const contextLength = await probeContextLength(
      serverRoot(resolveOpenAIEndpoint(url)),
      headers,
    );
    return { ok: true, models, contextLength };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach server' };
  }
}

// Vision probe cache: never hit the same server+model twice with a test image.
// Key = `${endpoint}|${model}` so a server that later swaps an mmproj in with
// a /v1/models DELETE+ADD gets re-probed (different id) naturally.
const visionProbeCache = new Map<string, boolean>();

// A 1x1 PNG is enough for the server to accept-or-reject the request — the
// round either completes (vision works) or the server refuses with an
// image-specific error (text-only build, "provide the mmproj"). Never a real
// vision call, just a capability handshake.
const VISION_PROBE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Name-based capability fallback for servers that publish no metadata at all
// (LM Studio, Ollama /v1, vLLM, text-gen-webui). Heuristic only — the user can
// always override the stored toggles. Returns `true`/`false` when the id is
// informative, `undefined` when truly ambiguous (keep the manual toggle).
// Exported for unit tests.
export function isVisionModelName(id: string): boolean | undefined {
  const lower = id.toLowerCase();
  if (/(^|\/|[-_.])vl($|[^a-z0-9])|vision|multimodal|omni|llava|molmo|qwen2-vl|internvl|phi-3(\W|\.|_)?vision|gemma-?3(-|$)|cogvlm|fuyu|minicpm-v|idefics|paligemma/.test(lower)) {
    return true;
  }
  if (/(^|\/|[-_.])text($|[^a-z0-9])|-text($|[^a-z0-9])|-bare($|[^a-z0-9])|(^|\/)text-/.test(lower)) {
    return false;
  }
  return undefined;
}

// Tool-calling name heuristic: instruct/chat/coder/it builds generally expose
// tool calling, base/raw/pre-train builds usually do not.
function isToolsModelName(id: string): boolean | undefined {
  const lower = id.toLowerCase();
  if (/instruct|chat|coder|\b-it\b|new-tool|tool\b/.test(lower)) return true;
  if (/(^|\/|[-_.])(base|raw|pretrain|pre-train|foundation)([^a-z0-9]|$)/.test(lower)) return false;
  return undefined;
}

// Probe models whose vision capability is still UNKNOWN (no server metadata,
// no name signal) by sending a tiny image and watching the server's reaction.
// A completed round proves vision; an image-specific refusal ("image input is
// not supported", "mmproj", "does not support images") proves text-only. Runs
// only for unknown entries, is cached per endpoint+model, and best-effort —
// any network hiccup leaves the entry unknown rather than failing Detect.
async function probeModelVision(
  models: LocalModelInfo[],
  endpointBase: string,
  headers: Record<string, string>,
): Promise<void> {
  const unknown = models.filter((m) => m.vision === undefined);
  const toProbe = unknown.filter((m) => !visionProbeCache.has(`${endpointBase}|${m.id}`));
  if (toProbe.length === 0) return;
  const chatUrl = `${endpointBase}/chat/completions`;
  // Probe a couple at a time — never more than ~6s total added to Detect.
  for (const m of toProbe.slice(0, 3)) {
    const key = `${endpointBase}|${m.id}`;
    const cached = visionProbeCache.get(key);
    if (cached !== undefined) {
      m.vision = cached;
      continue;
    }
    try {
      const body = JSON.stringify({
        model: m.id,
        messages: [
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: VISION_PROBE_PNG } },
            { type: 'text', text: 'Describe this image in one word.' },
          ] },
        ],
        max_tokens: 8,
        stream: false,
      });
      const res = await request(chatUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body }, 4_000);
      if (res.status >= 200 && res.status < 300) {
        m.vision = true;
        visionProbeCache.set(key, true);
      } else {
        const hint = res.body.slice(0, 400).toLowerCase();
        const refused = /image|vision|mmproj|multimodal|visual|not support|input type/.test(hint);
        m.vision = refused ? false : undefined;
        if (refused) visionProbeCache.set(key, false);
      }
    } catch {
      /* probe is best-effort — leave vision unknown */
    }
  }
}

// Lightweight Local AI connection test: probes /props (reachability + context
// window) with a /v1/models fallback for servers without /props. Returns a
// short human label. Unlike detectLocalModels this never parses model lists.
export async function testLocalAiServer(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderTestResult & { contextLength?: number }> {
  const url = baseUrl.trim();
  if (!url) return { ok: false, error: 'Empty server address' };
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = apiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  const root = serverRoot(resolveOpenAIEndpoint(url));
  try {
    const ctx = await probeContextLength(root, headers);
    if (ctx !== undefined) {
      return {
        ok: true,
        label: `Connected · ${ctx.toLocaleString()} token context`,
        contextLength: ctx,
      };
    }
    // No /props — fall back to the models endpoint for a plain reachability
    // check, mirroring detectLocalModels' error messages.
    const res = await request(`${root}/v1/models`, { headers }, 5_000);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Server rejected the API key (401/403).' };
    }
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status} from ${root}/v1/models` };
    }
    return { ok: true, label: 'Connected', contextLength: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach server' };
  }
}

// Probe the opencode target: the local opencode bridge
// (`GET {baseUrl}/v1/models`) — the connection test for the opencode
// provider, which is configured by base URL like Local AI rather than by an
// API key. Any 2xx with a list body counts; capability detail comes from
// detectOpencodeModels below.
export async function testOpencodeServer(baseUrl: string): Promise<ProviderTestResult> {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (!url) return { ok: false, error: 'Empty server address' };
  try {
    const endpoint = `${resolveOpenAIEndpoint(url)}/models`;
    const res = await request(endpoint, { headers: { Accept: 'application/json' } }, 5_000);
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status} from ${endpoint}` };
    }
    return { ok: true, label: 'Connected to opencode' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach server' };
  }
}

// Discover the free models the proxy serves by hitting its OpenAI-compatible
// `GET {baseUrl}/v1/models` endpoint. The list is flat
// (`{ object: 'list', data: [{ id }] }`) with no capability metadata, so
// entries carry ids only — vision/tools/web stay on the stored Settings
// toggles. Live on every call, so the proxy catalog refresh picks up new
// free models on the next refresh.
export async function detectOpencodeModels(
  baseUrl: string,
): Promise<LocalModelsResult> {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (!url) return { ok: false, error: 'Empty server address' };
  try {
    const endpoint = `${resolveOpenAIEndpoint(url)}/models`;
    const res = await request(endpoint, { headers: { Accept: 'application/json' } }, 5_000);
    if (res.status >= 400) {
      return { ok: false, error: `HTTP ${res.status} from ${endpoint}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      return { ok: false, error: 'Server returned a non-JSON /v1/models response.' };
    }
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      return { ok: false, error: 'Server returned an unexpected /v1/models response.' };
    }
    const models: LocalModelInfo[] = data
      .map((raw): LocalModelInfo | null => {
        const m = raw as { id?: unknown };
        if (typeof m?.id !== 'string' || m.id.length === 0) return null;
        return { id: m.id };
      })
      .filter((m): m is LocalModelInfo => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach server' };
  }
}

export async function testProviderKey(
  provider: ProviderId,
  apiKey: string,
): Promise<ProviderTestResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: 'Empty API key' };
  switch (provider) {
    case 'openrouter':
      return testOpenRouter(trimmed);
    case 'anthropic':
      return testAnthropic(trimmed);
    case 'openai':
      return testOpenAI(trimmed);
    case 'gemini':
      return testGemini(trimmed);
    case 'localai':
      // A key alone cannot validate a local server — its address is what
      // matters. The Settings UI routes Local AI through detectLocalModels,
      // which probes the base URL and doubles as the connection test.
      return { ok: false, error: 'Use Detect models to test a Local AI server.' };
    case 'opencode':
      // opencode is a local server configured by its base URL like Local AI —
      // no API key. Validate it by pinging the server instead.
      return { ok: false, error: 'Use a connection test to verify the opencode server.' };
  }
}
