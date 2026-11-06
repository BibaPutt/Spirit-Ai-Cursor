# 07 — Providers & Router (`electron/llm/providers/*`)

Hand-rolled HTTP/SSE clients for each LLM provider — no SDKs. The **router**
orchestrates them, resolves API keys through a provider chain, streams
chunks/tool calls, and drives the agentic tool loop.

## `types.ts`
- `ProviderId` = `'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'localai' | 'opencode'`
- `ModelCapability` = `'vision' | 'tools' | 'web'` — capability flags used to
  decide which model/route to pick.
- `ProviderConfig` — per-provider endpoint + model mapping.
- `StreamHandlers` — `{ onChunk(text), onToolCall(call), onDone(usage?), onError(err) }`.
- `RequestRequirements` — what a request needs (image? tools? web?).
- `ProviderRoundResult` — outcome of one round (text + tool calls + done flag).
- `AgentContext` — the agent loop's working state (messages, tools, budget).
- `ProviderClient` — the interface every provider implements:
  `stream(...)`, `execute(...)`, `testKey(...)`, `capabilities`.
- `HTTP_HEADERS_BASE`, `ProviderHttpError`, `shouldRetryStatus(status)` —
  shared HTTP helpers.

## `registry.ts`
- `PROVIDER_ORDER` — the fallback chain order.
- `getProvider(id)` / `getAllProviders()`.

## `router.ts`
The central orchestrator:
- `resolveProviderChain()` → `ChainResolution` — builds the ordered list of
usable providers from settings (enabled + key). LocalAI and opencode are
   treated specially (baseUrl required; key optional).
- `runPlainCompletion(...)` → `StreamHandle { cancel }` — the main entry used
  by `handlers.ts`:
  1. normalizes messages (image blocks, tool definitions),
  2. walks the chain: tries each provider in order, streaming chunks/tool
     calls via `StreamHandlers`, retrying transient failures
     (`shouldRetryStatus`),
  3. returns a handle that can `cancel()` the stream (ESC path),
  4. surfaces actionable keychain errors (see `secure-keys` decrypt failure
     reasons in 10-store).
- The **agentic tool loop** (`AgentRunResult`): while the model emits tool
  calls, `executeTool` runs them (with approval gating), the result is appended
  as a tool message, and the loop continues until the model stops or
  `ROUND_TIMEOUT_MS` is hit.

## Provider clients
- `openrouter.ts` — `openRouterProvider`. OpenAI-compatible chat completions
  against OpenRouter with tool calling and image support.
- `anthropic.ts` — `anthropicProvider`. Messages API, stream parsing
  (content_block_delta / tool_use).
- `openai.ts` — `openaiProvider`. Chat completions + tools.
- `openai-stream.ts` — `parseOpenAIStream(...)` — shared OpenAI-compatible SSE
  parser (used by openai + localai).
- `gemini.ts` — `geminiProvider`. generateContent streaming.
- `localai.ts` — `localaiProvider` + `resolveOpenAIEndpoint(baseUrl)` — any
  OpenAI-compatible local server (Ollama/LM Studio/LocalAI etc.).
- `opencode.ts` — `opencodeProvider` (+ `resolveOpencodeEndpoint`). Targets the
  local opencode bridge (default `http://127.0.0.1:4096`),
  which serves free models over OpenAI wire (`/v1/models`,
  `/v1/chat/completions` SSE). Tools relay upstream; vision rides only when
  the toggle is on (image blocks stripped otherwise). No key needed.

## `test-key.ts`
- `testProviderKey(...)` — one-shot key validation used by the Settings form
  ("Test key" button) and the provider-health probes.

## Health probing & decrypt failures
`probeProviderHealth` (store/secure-keys) decrypts every stored key once at
startup and records per-provider failures. `getProvidersHealth()` (settings)
exposes them; a broken decrypt shows the `ProviderHealthBanner` in the
renderer with an actionable message instead of a generic "No provider
configured".

See also [06-llm.md](06-llm.md) (prompt/models), [08-tools.md](08-tools.md),
[10-store.md](10-store.md) (secure-keys).
