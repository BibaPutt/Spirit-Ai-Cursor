import { describe, expect, it } from 'vitest';
import { SEED_TESTS, buildSeedTurns } from '../renderer/lib/testSeeds';

describe('test seeds', () => {
  it('catalog is non-empty with unique ids', () => {
    expect(SEED_TESTS.length).toBeGreaterThan(0);
    const ids = SEED_TESTS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of SEED_TESTS) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.questions.length).toBeGreaterThan(0);
    }
  });

  it('builds transcript-shaped turns with unique ids', () => {
    const turns = buildSeedTurns(SEED_TESTS[0]);
    expect(turns.length).toBe(SEED_TESTS[0].questions.length);
    const ids = turns.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of turns) {
      expect(t.prompt.trim().length).toBeGreaterThan(0);
      expect(t.response.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(t.uiSegments)).toBe(true);
    }
  });
});
