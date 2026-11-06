import { describe, expect, it } from 'vitest';
import {
  FALLBACK_CONTEXT_WINDOW,
  LOCAL_DEFAULT_CONTEXT_WINDOW,
  resolveAutoContextBudget,
  resolveModelContextWindow,
  roundFuseMs,
  ROUND_TIMEOUT_MS,
} from '../electron/llm/models';

describe('auto context', () => {
  it('local servers get the small boot window', () => {
    expect(resolveModelContextWindow('qwen3.5', true)).toBe(LOCAL_DEFAULT_CONTEXT_WINDOW);
    expect(resolveAutoContextBudget('anything', true)).toBeLessThanOrEqual(LOCAL_DEFAULT_CONTEXT_WINDOW);
  });

  it('matches longest model substring', () => {
    expect(resolveModelContextWindow('google/gemma-4-26b-a4b-it:free', false)).toBe(128_000);
    expect(resolveModelContextWindow('anthropic/claude-opus', false)).toBe(200_000);
  });

  it('falls back for unknown cloud ids', () => {
    expect(resolveModelContextWindow('mystery-model-9', false)).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  it('budget reserves output headroom but stays usable', () => {
    const b = resolveAutoContextBudget('google/gemma-4-26b-a4b-it:free', false);
    expect(b).toBeGreaterThan(80_000);
    expect(b).toBeLessThan(128_000);
    expect(resolveAutoContextBudget('tiny', true)).toBeGreaterThanOrEqual(2000);
  });

  it('slow lanes get a longer round fuse', () => {
    expect(roundFuseMs('opencode')).toBeGreaterThan(ROUND_TIMEOUT_MS);
    expect(roundFuseMs('localai')).toBeGreaterThanOrEqual(ROUND_TIMEOUT_MS);
    expect(roundFuseMs('openrouter')).toBe(ROUND_TIMEOUT_MS);
    expect(roundFuseMs()).toBe(ROUND_TIMEOUT_MS);
  });
});
