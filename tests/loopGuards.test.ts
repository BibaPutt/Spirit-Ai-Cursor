import { describe, expect, it } from 'vitest';
import {
  isAllErrorStreakHit,
  isBadInputStreakHit,
  isIdenticalStallHit,
  MAX_ALL_ERROR_ROUNDS,
  MAX_BAD_INPUT_ROUNDS,
  MAX_IDENTICAL_ROUNDS,
  nextAllErrorStreak,
  nextBadInputStreak,
  nextIdenticalStallCount,
  toolRoundFingerprint,
} from '../electron/llm/loop-guards';

describe('toolRoundFingerprint', () => {
  it('is order-insensitive', () => {
    const a = toolRoundFingerprint([
      { name: 'ui_click', args: { x: 10, y: 20 } },
      { name: 'web_search', args: { q: 'news' } },
    ]);
    const b = toolRoundFingerprint([
      { name: 'web_search', args: { q: 'news' } },
      { name: 'ui_click', args: { x: 10, y: 20 } },
    ]);
    expect(a).toBe(b);
  });

  it('differs when args differ', () => {
    const a = toolRoundFingerprint([{ name: 'ui_click', args: { x: 10, y: 20 } }]);
    const b = toolRoundFingerprint([{ name: 'ui_click', args: { x: 11, y: 21 } }]);
    expect(a).not.toBe(b);
  });

  it('is empty for an empty round', () => {
    expect(toolRoundFingerprint([])).toBe('');
  });
});

describe('nextIdenticalStallCount', () => {
  it('bumps when the fingerprint repeats and resets on change', () => {
    const fp = toolRoundFingerprint([{ name: 'ui_click', args: { x: 1, y: 2 } }]);
    expect(nextIdenticalStallCount(2, fp, fp)).toBe(3);
    const fp2 = toolRoundFingerprint([{ name: 'ui_click', args: { x: 9, y: 9 } }]);
    expect(nextIdenticalStallCount(2, fp2, fp)).toBe(1);
  });

  it('ignores empty rounds entirely', () => {
    expect(nextIdenticalStallCount(2, '', '')).toBe(0);
  });

  it('hits at the cap', () => {
    expect(isIdenticalStallHit(MAX_IDENTICAL_ROUNDS - 1)).toBe(false);
    expect(isIdenticalStallHit(MAX_IDENTICAL_ROUNDS)).toBe(true);
  });
});

describe('nextAllErrorStreak', () => {
  it('increments only when every executed call failed and resets otherwise', () => {
    expect(nextAllErrorStreak(0, 2, 2, 2)).toBe(1);
    expect(nextAllErrorStreak(1, 2, 2, 2)).toBe(2);
    expect(nextAllErrorStreak(2, 3, 3, 1)).toBe(0); // some success
    expect(nextAllErrorStreak(2, 2, 0, 0)).toBe(0); // nothing executed
    expect(nextAllErrorStreak(2, 0, 0, 0)).toBe(0); // no calls
  });

  it('hits at the cap', () => {
    expect(isAllErrorStreakHit(MAX_ALL_ERROR_ROUNDS)).toBe(true);
  });
});

describe('nextBadInputStreak', () => {
  it('increments when the whole round was unparseable input', () => {
    expect(nextBadInputStreak(0, 2, 2, 0)).toBe(1);
    expect(nextBadInputStreak(1, 1, 1, 0)).toBe(2);
    expect(nextBadInputStreak(1, 2, 1, 1)).toBe(0); // half executed
    expect(nextBadInputStreak(1, 2, 2, 1)).toBe(0); // something executed
    expect(nextBadInputStreak(1, 0, 0, 0)).toBe(0); // no calls
  });

  it('hits at the cap', () => {
    expect(isBadInputStreakHit(MAX_BAD_INPUT_ROUNDS)).toBe(true);
  });
});