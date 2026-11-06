import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'spirit-test'),
    getName: () => 'Spirit',
    getVersion: () => 'test',
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
  },
}));

import {
  activeHourRange,
  clearPreferences,
  decayState,
  derivePreferenceLine,
  noteSubmit,
  preferencesLine,
  setPreferencesStorePathForTests,
  type PreferencesState,
} from '../electron/memory/preferences';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function stateWith(hours: Record<string, number>, apps: PreferencesState['apps'] = {}, updatedAt = Date.now()): PreferencesState {
  return { version: 1, hours, apps, updatedAt };
}

beforeEach(() => {
  setPreferencesStorePathForTests(join(tmpdir(), `spirit-prefs-${Date.now()}-${Math.random()}.json`));
});
afterEach(() => {
  setPreferencesStorePathForTests(null);
});

describe('decayState', () => {
  it('halves weights per half-life and prunes faded entries', () => {
    const s = stateWith({ '9': 8, '3': 0.4 }, {}, Date.now());
    const d = decayState(s, s.updatedAt + 14 * DAY);
    expect(d.hours['9']).toBeCloseTo(4, 5);
    expect(d.hours['3']).toBeUndefined(); // 0.2 < MIN_WEIGHT
  });

  it('is a no-op within rounding of updatedAt', () => {
    const s = stateWith({ '9': 4 }, {}, Date.now());
    const d = decayState(s, s.updatedAt + 1000);
    expect(d.hours['9']).toBe(4);
  });
});

describe('activeHourRange', () => {
  it('finds a contiguous daytime cluster', () => {
    const hours: Record<string, number> = {};
    for (let h = 9; h <= 15; h++) hours[String(h)] = 10;
    hours['4'] = 1; // stray outlier below the 40% threshold
    expect(activeHourRange(hours)).toEqual([9, 16]);
  });

  it('handles a cluster that wraps midnight', () => {
    const hours: Record<string, number> = { '22': 6, '23': 6, '0': 6, '1': 6 };
    expect(activeHourRange(hours)).toEqual([22, 2]);
  });

  it('returns null for sparse data', () => {
    expect(activeHourRange({ '9': 1 })).toBeNull();
    expect(activeHourRange({})).toBeNull();
  });
});

describe('derivePreferenceLine', () => {
  it('is empty with no data', () => {
    expect(derivePreferenceLine(stateWith({}))).toBe('');
  });

  it('reports hours and a dominant app', () => {
    const hours: Record<string, number> = {};
    for (let h = 9; h <= 16; h++) hours[String(h)] = 10;
    const s = stateWith(hours, {
      code: { w: 30, lastAt: Date.now() },
      explorer: { w: 4, lastAt: Date.now() },
    });
    const line = derivePreferenceLine(s);
    expect(line).toContain('Preferences: ');
    expect(line).toContain('usually active 09:00-17:00');
    expect(line).toContain('usually works in code');
  });

  it('omits a non-dominant app', () => {
    const hours: Record<string, number> = {};
    for (let h = 9; h <= 16; h++) hours[String(h)] = 10;
    const s = stateWith(hours, {
      code: { w: 10, lastAt: Date.now() },
      explorer: { w: 9, lastAt: Date.now() },
    });
    expect(derivePreferenceLine(s)).not.toContain('usually works in');
  });
});

describe('noteSubmit glue', () => {
  it('records counters, skips empty app keys, and renders a line', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) noteSubmit('Code.exe', now + i * HOUR);
    noteSubmit('', now + 6 * HOUR);
    const line = preferencesLine();
    expect(line).toContain('Preferences: ');
    expect(line).toContain('code');
    expect(line).not.toContain('unknown');
  });

  it('clearPreferences empties the rendered line', () => {
    noteSubmit('Code.exe', Date.now());
    clearPreferences();
    expect(preferencesLine()).toBe('');
  });
});
