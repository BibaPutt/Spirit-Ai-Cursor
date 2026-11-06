import { describe, expect, it } from 'vitest';
import { wiggleTuningForLevel } from '../electron/input/wiggle-tuning';

describe('wiggleTuningForLevel', () => {
  it('high is the original easily-triggered tuning', () => {
    expect(wiggleTuningForLevel('high')).toEqual({
      windowMs: 1100,
      amplitudePx: 45,
      reversals: 3,
    });
  });

  it('unknown values fall back to high (current behavior preserved)', () => {
    expect(wiggleTuningForLevel(undefined)).toEqual(wiggleTuningForLevel('high'));
    expect(wiggleTuningForLevel('turbo')).toEqual(wiggleTuningForLevel('high'));
  });

  it('low needs a bigger, longer, more deliberate shake', () => {
    const low = wiggleTuningForLevel('low');
    const high = wiggleTuningForLevel('high');
    expect(low.amplitudePx).toBeGreaterThan(high.amplitudePx);
    expect(low.reversals).toBeGreaterThan(high.reversals);
    expect(low.windowMs).toBeLessThan(high.windowMs);
  });

  it('normal sits between low and high', () => {
    const normal = wiggleTuningForLevel('normal');
    expect(normal.amplitudePx).toBeGreaterThan(wiggleTuningForLevel('high').amplitudePx);
    expect(normal.amplitudePx).toBeLessThan(wiggleTuningForLevel('low').amplitudePx);
  });
});
