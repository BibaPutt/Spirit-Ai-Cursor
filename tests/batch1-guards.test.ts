import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadableStream } from 'node:stream/web';

const hoisted = vi.hoisted(() => ({
  cfg: {
    apiKey: '',
    enabled: true,
    baseUrl: 'http://127.0.0.1:4096',
    model: 'some-free-model',
    availableModels: [],
    vision: false,
    tools: true,
    web: false,
    contextLength: undefined,
  },
}));

vi.mock('../electron/store/settings', () => ({
  getOpencodeConfig: () => hoisted.cfg,
  getLocalAiConfig: () => ({ model: 'm', baseUrl: 'http://localhost:1234', vision: false, tools: false, web: false }),
  getChipsLocalAiConfig: () => ({ model: 'm', baseUrl: 'http://localhost:1234', vision: false, tools: false, web: false }),
}));

import {
  isOpencodeDownError,
  opencodeProvider,
  resetOpencodeDownWarningsForTests,
  setOpencodeRetryDelayForTests,
  setOpencodeTimeoutRetryForTests,
  warnOpencodeDownOnce,
} from '../electron/llm/providers/opencode';
import {
  isLocalDownError,
  resetLocalDownWarningsForTests,
  warnLocalDownOnce,
} from '../electron/llm/providers/localai';
import {
  lastAIActivityAt,
  MAX_ROUND_ATTEMPTS,
  noteAIActivity,
  retryWaitMs,
  runWithRoundRetries,
  setRoundRetryWaitForTests,
  withAttemptTimeout,
} from '../electron/llm/providers/round-retry';
import { isSmallPlainScroll } from '../electron/llm/tools/approval';
import { isNeverDeclineScroll } from '../electron/input/engine-decision';
import * as fs from 'node:fs';
import * as path from 'node:path';

function routerSource(): string {
  return fs.readFileSync(path.join(__dirname, '..', 'electron', 'llm', 'providers', 'router.ts'), 'utf8');
}

function sseBody(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

const STREAM = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

describe('batch1 guards', () => {
  beforeEach(() => {
    setOpencodeRetryDelayForTests(0);
    setOpencodeTimeoutRetryForTests(0);
    setRoundRetryWaitForTests(0);
    resetOpencodeDownWarningsForTests();
    resetLocalDownWarningsForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setOpencodeRetryDelayForTests(null);
    setOpencodeTimeoutRetryForTests(null);
    setRoundRetryWaitForTests(null);
  });

  it('local-down warns once per provider', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isLocalDownError(new Error('fetch failed'))).toBe(true);
    expect(isLocalDownError(new Error('plain bad request'))).toBe(false);
    expect(warnLocalDownOnce('localai', new Error('fetch failed'))).toBe(true);
    expect(warnLocalDownOnce('localai', new Error('fetch failed'))).toBe(false);
    expect(warnLocalDownOnce('other-local', new Error('fetch failed'))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('opencode down warns once', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isOpencodeDownError(new TypeError('fetch failed'))).toBe(true);
    expect(warnOpencodeDownOnce(new TypeError('fetch failed'))).toBe(true);
    expect(warnOpencodeDownOnce(new TypeError('fetch failed'))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('universal retry: any failing round tries 5 times, then throws', async () => {
    let n = 0;
    await expect(
      runWithRoundRetries('test', undefined, () => {
        n++;
        return Promise.reject(new Error('fetch failed'));
      }),
    ).rejects.toThrow('fetch failed');
    expect(n).toBe(5);
  });

  it('universal retry: success on a later attempt stops retrying', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n === 1) throw abortErr;
      return { ok: true, status: 200, statusText: 'OK', body: sseBody(STREAM) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await runWithRoundRetries('opencode', undefined, () =>
      opencodeProvider.runRound(
        'some-free-model', [{ role: 'user', content: 'hi' }], '', undefined, undefined, () => {},
      ),
    );
    expect(res.contentText).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('universal retry: user cancel never retries', async () => {
    const c = new AbortController();
    c.abort(new Error('user stop'));
    let n = 0;
    await expect(
      runWithRoundRetries('test', c.signal, () => {
        n++;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(n).toBe(1);
  });

  it('retry backoff grows to the 60s cap', () => {
    setRoundRetryWaitForTests(null);
    try {
      expect(retryWaitMs(0)).toBeLessThanOrEqual(10_000);
      expect(retryWaitMs(99)).toBe(60_000);
      expect(MAX_ROUND_ATTEMPTS).toBe(5);
    } finally {
      setRoundRetryWaitForTests(0);
    }
  });

  it('background paths retry at most twice', async () => {
    let n = 0;
    await expect(
      runWithRoundRetries('chips', undefined, () => {
        n++;
        return Promise.reject(new Error('fetch failed'));
      }, undefined, 2),
    ).rejects.toThrow('fetch failed');
    expect(n).toBe(2);
  });

  it('AI activity clock moves on touch', () => {
    const before = lastAIActivityAt();
    noteAIActivity();
    expect(lastAIActivityAt()).toBeGreaterThanOrEqual(before);
  });

  it('attempt timeout aborts as a plain timeout error', async () => {
    const c = new AbortController();
    const { signal, cancel } = withAttemptTimeout(c.signal, 30);
    try {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error(String(signal.reason))), { once: true });
        setTimeout(() => reject(new Error('never aborted')), 2000);
      });
      expect.unreachable('should have aborted');
    } catch (err) {
      expect(String(err)).toMatch(/timeout/i);
    } finally {
      cancel();
    }
  });

  it('user abort still wins over the attempt timeout', async () => {
    const c = new AbortController();
    c.abort(new Error('user stop'));
    const { signal, cancel } = withAttemptTimeout(c.signal, 60_000);
    try {
      let n = 0;
      await expect(
        runWithRoundRetries('hang', signal, () => {
          n++;
          return Promise.reject(new Error('boom'));
        }),
      ).rejects.toThrow('boom');
      expect(n).toBe(1);
    } finally {
      cancel();
    }
  });

  it('new cap values', () => {
    const src = routerSource();
    const guarded = /export const MAX_RUNS_PER_GUARDED_TOOL\s*=\s*(\d+)/.exec(src);
    expect(guarded?.[1]).toBe('3');
    const info = /export const MAX_INFO_LOOKUPS_PER_RUN\s*=\s*(\d+)/.exec(src);
    expect(Number(info?.[1])).toBeGreaterThanOrEqual(6);
  });

  it('plain small scroll is never declined; everything else unchanged', () => {
    expect(isSmallPlainScroll('scroll', { delta: 3 })).toBe(true);
    expect(isSmallPlainScroll('scroll', { delta: -5 })).toBe(true);
    expect(isSmallPlainScroll('scroll', { delta: 0 })).toBe(false);
    expect(isSmallPlainScroll('scroll', { delta: 50 })).toBe(false);
    expect(isSmallPlainScroll('scroll', { delta: 2, x: 1 })).toBe(false);
    expect(isSmallPlainScroll('click', { x: 1, y: 2 })).toBe(false);
    expect(isSmallPlainScroll('focus_window', { app: 'X' })).toBe(false);
    expect(isNeverDeclineScroll('scroll', { delta: 2 })).toBe(true);
    expect(isNeverDeclineScroll('scroll', { delta: 99 })).toBe(false);
    expect(isNeverDeclineScroll('click', { x: 1, y: 1 })).toBe(false);
  });
});
