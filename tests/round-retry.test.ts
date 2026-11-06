import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RETRY_BACKOFF_CAP_MS,
  parseRetryAfterMs,
  retryWaitMs,
  retryWaitMsWithJitter,
  setRoundRetryWaitForTests,
  withAttemptTimeout,
  withProgressTimeout,
} from '../electron/llm/providers/round-retry';

afterEach(() => {
  vi.useRealTimers();
  setRoundRetryWaitForTests(null);
});

describe('withProgressTimeout', () => {
  it('does not fire while the stream keeps touching the bound', () => {
    vi.useFakeTimers();
    const bound = withProgressTimeout(undefined, 100);
    vi.advanceTimersByTime(80);
    bound.touch();
    vi.advanceTimersByTime(80);
    expect(bound.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(30);
    expect(bound.signal?.aborted).toBe(true);
    bound.cancel();
  });

  it('fires after genuine silence with a retryable timeout reason', () => {
    vi.useFakeTimers();
    const bound = withProgressTimeout(undefined, 50);
    vi.advanceTimersByTime(60);
    expect(bound.signal?.aborted).toBe(true);
    const reason = bound.signal?.reason;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('timeout');
    bound.cancel();
  });

  it('forwards a user cancel from the parent signal', () => {
    const parent = new AbortController();
    const bound = withProgressTimeout(parent.signal, 60_000);
    parent.abort(new Error('user cancelled'));
    expect(bound.signal?.aborted).toBe(true);
    expect((bound.signal?.reason as Error).message).toBe('user cancelled');
    bound.cancel();
  });

  it('cancel() disarms a pending deadline', () => {
    vi.useFakeTimers();
    const bound = withProgressTimeout(undefined, 40);
    bound.cancel();
    vi.advanceTimersByTime(100);
    expect(bound.signal?.aborted).toBe(false);
  });

  it('ms <= 0 is unbounded (no timer)', () => {
    vi.useFakeTimers();
    const bound = withProgressTimeout(undefined, 0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(bound.signal?.aborted ?? false).toBe(false);
    bound.cancel();
  });
});

describe('withAttemptTimeout compatibility', () => {
  it('still aborts a whole attempt after the fixed window', () => {
    vi.useFakeTimers();
    const bound = withAttemptTimeout(undefined, 30);
    vi.advanceTimersByTime(40);
    expect(bound.signal?.aborted).toBe(true);
    bound.cancel();
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '12' }))).toBe(12_000);
  });

  it('clamps a huge hint to the backoff cap', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '9999' }))).toBe(RETRY_BACKOFF_CAP_MS);
  });

  it('parses an HTTP-date', () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(new Headers({ 'retry-after': at }));
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(3000);
    expect(ms!).toBeLessThanOrEqual(5000);
  });

  it('treats a past HTTP-date as zero', () => {
    const at = new Date(Date.now() - 5000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': at }))).toBe(0);
  });

  it('returns null for absent / unparseable values', () => {
    expect(parseRetryAfterMs(new Headers())).toBeNull();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'soon-ish' }))).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});

describe('retryWaitMsWithJitter', () => {
  it('keeps the fixed test wait exact', () => {
    setRoundRetryWaitForTests(123);
    expect(retryWaitMsWithJitter(0)).toBe(123);
    expect(retryWaitMsWithJitter(99)).toBe(123);
  });

  it('never exceeds the deterministic schedule and never goes below 80% of it', () => {
    setRoundRetryWaitForTests(null);
    for (const attempt of [0, 1, 2, 3, 9]) {
      const base = retryWaitMs(attempt);
      const jittered = retryWaitMsWithJitter(attempt);
      expect(jittered).toBeLessThanOrEqual(base);
      expect(jittered).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
    }
  });

  it('stays capped at 60s', () => {
    setRoundRetryWaitForTests(null);
    expect(retryWaitMs(9)).toBe(RETRY_BACKOFF_CAP_MS);
    expect(retryWaitMsWithJitter(9)).toBeLessThanOrEqual(RETRY_BACKOFF_CAP_MS);
  });
});
