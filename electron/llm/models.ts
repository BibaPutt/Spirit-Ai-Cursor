// OpenRouter default model settings. Free variants only: the app needs both
// vision (screenshot on every trigger) and tools (agentic ui_read/ui_click).
// The only free OpenRouter models with both are Google's Gemma 4 family —
// there is no free Gemini 3.
export const MODELS = {
  PRIMARY: 'google/gemma-4-26b-a4b-it:free',
  FALLBACK: 'google/gemma-4-31b-it:free',
} as const;

export const REASONING_EFFORT = 'minimal' as const;
// Output budget per model response. 800 was too small for reasoning models
// (Gemma 4, DeepSeek-R1, QwQ...): they stream chain-of-thought into
// `reasoning_content` and were cut off mid-thought before ever emitting the
// actual answer or tool call, so multi-step tasks returned empty rounds.
// Local agent rounds now send reasoning_effort:"none" (see localai.ts), so
// thinking no longer eats this budget. This is a cap, not a target —
// providers only produce what they need. Raised to 32768 (x4): long verification
// rounds (multi-fetch tasks) kept hitting thinking-limit cutoffs even at 8192.
// Free-tier cloud models accept it; small local servers clamp or ignore what
// they can't serve, and localai.ts self-calibrates overflows anyway.
export const MAX_TOKENS = 32768;
// Per-round watchdog for agentic tool runs. Each LLM round (planning,
// composition) gets this much wall-clock time before the run is aborted.
// Time spent waiting for tool approval or executing a tool is NOT counted,
// so a whole multi-step task can legitimately take minutes while a provider
// that hangs mid-round still gets cut off. This replaced the old whole-run
// 30s cap, which killed real multi-step tasks on slow local models right
// after the tools executed and before the final answer was composed. Generous
// margin on purpose: a reasoning model can spend ~60-90s on one big round.
export const ROUND_TIMEOUT_MS = 240_000;

// Slow lanes get a longer per-round fuse: free-proxy upstreams queue for
// minutes before the first token, small local servers think slowly. Local AI
// gets the longest fuse of all (10 min) — a thinking local model must never
// be killed mid-thought; any arriving token/thinking already re-arms the fuse
// (see touchFuse in router.ts), so this only fires on a true hang.
export function roundFuseMs(providerId?: string): number {
  if (providerId === 'opencode') return 600_000;
  if (providerId === 'localai') return 600_000;
  return ROUND_TIMEOUT_MS;
}

// Per-model context windows (input tokens, advertised). Substring match,
// longest key wins — Hermes' model_metadata does the same. Unknown ids fall
// back to FALLBACK_CONTEXT_WINDOW; local servers boot small (-c 32768), so
// they get their own default.
const MODEL_CONTEXT_WINDOWS: Array<[needle: string, window: number]> = [
  ['gpt-5', 400_000],
  ['gpt-4', 128_000],
  ['o1', 200_000],
  ['o3', 200_000],
  ['o4', 200_000],
  ['claude', 200_000],
  ['gemini', 1_000_000],
  ['gemma', 128_000],
  ['qwen', 128_000],
  ['lfm', 128_000],
  ['deepseek', 128_000],
  ['llama', 128_000],
];
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const LOCAL_DEFAULT_CONTEXT_WINDOW = 32_768;

export function resolveModelContextWindow(modelId: string, isLocal: boolean): number {
  if (isLocal) return LOCAL_DEFAULT_CONTEXT_WINDOW;
  const id = (modelId ?? '').toLowerCase();
  let best = 0;
  let bestLen = 0;
  for (const [needle, window] of MODEL_CONTEXT_WINDOWS) {
    if (needle.length > bestLen && id.includes(needle)) {
      best = window;
      bestLen = needle.length;
    }
  }
  return best > 0 ? best : FALLBACK_CONTEXT_WINDOW;
}

// Auto context budget: the model's window minus an output reserve, so the
// harness fills what the model can actually serve instead of a fixed user
// number. Reserve is capped at 20% — MAX_TOKENS-sized reserves would starve
// small local windows.
export function resolveAutoContextBudget(modelId: string, isLocal: boolean): number {
  const window = resolveModelContextWindow(modelId, isLocal);
  const reserve = Math.min(MAX_TOKENS, Math.floor(window * 0.2));
  return Math.max(2000, window - reserve);
}
