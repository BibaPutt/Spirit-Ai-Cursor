// Universal round retry: ANY provider round that fails is retried up to 5
// attempts with backoff growing to a 60s cap (2s, 6s, 18s, 54s) before the
// caller fails over. Free/shared upstreams flap and queue — a single try was
// never enough. User-cancel abort never retries. Pure + test-hooked.
export const MAX_ROUND_ATTEMPTS = 5;
export const RETRY_BACKOFF_CAP_MS = 60_000;
const RETRY_BACKOFF_SCHEDULE = [2000, 6000, 18_000, 60_000];

// Attempt-scoped timeout: aborts `ms` after creation unless cancelled.
// Reason is a plain 'timeout' Error so isUserCancel() treats it as
// retryable and the router classifies it for failover — same as the round
// fuse. Exists because a half-open server (accepts, never replies) hangs
// fetch/SSE forever; the router fuse should catch it, but a provider must
// never depend on caller wiring for its own upper bound.
export function withAttemptTimeout(
  parent: AbortSignal | undefined | null,
  ms: number,
): { signal: AbortSignal | undefined; cancel: () => void } {
  if (!ms || ms <= 0) return { signal: parent ?? undefined, cancel: () => {} };
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new Error('timeout')), ms);
  const fwd = (): void => {
    try {
      c.abort((parent as AbortSignal).reason);
    } catch {
      /* already settled */
    }
  };
  if (parent?.aborted) fwd();
  else parent?.addEventListener('abort', fwd, { once: true });
  return {
    signal: c.signal,
    cancel: () => {
      clearTimeout(timer);
      try {
        parent?.removeEventListener('abort', fwd);
      } catch {
        /* ignore */
      }
    },
  };
}
// Progress-scoped timeout: like withAttemptTimeout, but the deadline is
// re-armed by touch(). A long answer that keeps emitting chunks is never
// killed for total duration — only genuine silence (no headers, no bytes)
// fails the attempt. Reason is a plain 'timeout' Error so isUserCancel()
// still treats it as retryable.
export function withProgressTimeout(
  parent: AbortSignal | undefined | null,
  ms: number,
): { signal: AbortSignal | undefined; touch: () => void; cancel: () => void } {
  if (!ms || ms <= 0) {
    return { signal: parent ?? undefined, touch: () => {}, cancel: () => {} };
  }
  const c = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        c.abort(new Error('timeout'));
      } catch {
        /* already settled */
      }
    }, ms);
  };
  const fwd = (): void => {
    try {
      c.abort((parent as AbortSignal).reason);
    } catch {
      /* already settled */
    }
  };
  if (parent?.aborted) fwd();
  else {
    parent?.addEventListener('abort', fwd, { once: true });
    arm();
  }
  return {
    signal: c.signal,
    touch: () => {
      if (!c.signal.aborted) arm();
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        parent?.removeEventListener('abort', fwd);
      } catch {
        /* ignore */
      }
    },
  };
}

// Server backoff hint from a 429/503: seconds or an HTTP-date, clamped to the
// retry cap. Null when absent or unparseable so the caller keeps its schedule.
export function parseRetryAfterMs(headers: Headers | null | undefined): number | null {
  const raw = headers?.get?.('retry-after')?.trim();
  if (!raw) return null;
  const secs = Number(raw);
  let ms: number;
  if (Number.isFinite(secs) && secs >= 0) {
    ms = secs * 1000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    ms = Math.max(0, at - Date.now());
  }
  return Math.min(RETRY_BACKOFF_CAP_MS, Math.round(ms));
}

// success, tool call, and streamed chunk touches this. If AI mode is active
// and nothing touched it for WATCHDOG_STALL_MS, main force-ends the mode so
// the fullscreen mouse capture can never pin the screen forever.
// Liveness for the AI-mode dead-man's switch (handlers.ts): every attempt,
let lastAIActivity = Date.now();

export function noteAIActivity(): void {
  lastAIActivity = Date.now();
}

export function lastAIActivityAt(): number {
  return lastAIActivity;
}

// Fixed wait override for tests (null = use the schedule).
let fixedWaitMs: number | null = null;

export function setRoundRetryWaitForTests(ms: number | null): void {
  fixedWaitMs = ms;
}

export function retryWaitMs(failedAttempt: number): number {
  if (fixedWaitMs !== null) return fixedWaitMs;
  return Math.min(
    RETRY_BACKOFF_CAP_MS,
    RETRY_BACKOFF_SCHEDULE[Math.min(failedAttempt, RETRY_BACKOFF_SCHEDULE.length - 1)],
  );
}

// Same schedule, jittered DOWNWARD by up to 20% so a fleet of retries does
// not stampede the same upstream at the same instant. Never exceeds the cap.
export function retryWaitMsWithJitter(failedAttempt: number): number {
  const base = retryWaitMs(failedAttempt);
  if (fixedWaitMs !== null) return base;
  return Math.max(0, base - Math.floor(base * 0.2 * Math.random()));
}

// True when the abort came from the USER (cancel button), not a watchdog.
// Watchdog aborts carry an Error with message 'timeout' (see router fuse).
export function isUserCancel(signal?: AbortSignal | null): boolean {
  if (!signal?.aborted) return false;
  const r = signal.reason;
  return !(r instanceof Error && r.message === 'timeout');
}

function sleepOrAbort(ms: number, signal?: AbortSignal | null): Promise<void> {  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// Spent upstream quota never recovers inside a retry window — retrying a
// free-tier 429 here just repeats the same failure for minutes. Fail fast.
const TERMINAL_QUOTA_HINTS =
  /free tier quota|FreeUsageLimitError|free usage limit|subscribe to OpenCode Go/i;

export function isTerminalQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return TERMINAL_QUOTA_HINTS.test(err.message);
}

export async function runWithRoundRetries<T>(
  label: string,
  signal: AbortSignal | undefined | null,
  fn: () => Promise<T>,
  onFail?: (err: unknown, attempt: number) => void,
  maxAttempts = MAX_ROUND_ATTEMPTS,
): Promise<T> {
  const tries = Math.max(1, Math.min(MAX_ROUND_ATTEMPTS, Math.floor(maxAttempts)));
  let last: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    noteAIActivity();
    if (attempt > 0) {
      if (isUserCancel(signal)) throw last;
      const wait = retryWaitMsWithJitter(attempt - 1);
      console.warn(
        `[retry] ${label} attempt ${attempt + 1}/${tries} after ${wait}ms ` +
          `(${last instanceof Error ? (last.stack ?? last.message) : String(last)})`,
      );
      await sleepOrAbort(wait, signal ?? undefined);
      if (isUserCancel(signal)) throw last;
    }
    try {
      const out = await fn();
      noteAIActivity();
      return out;
    } catch (err) {
      last = err;
      try {
        onFail?.(err, attempt);
      } catch {
        /* down-warn helpers never break the retry */
      }
      if (isUserCancel(signal)) throw err;
      if (isTerminalQuotaError(err)) throw err;
    }
  }
  throw last;
}
