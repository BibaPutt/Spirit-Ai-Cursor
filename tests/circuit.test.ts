import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_FAILS,
  COOLDOWN_MS,
  HALF_OPEN_SUCCESS_THRESHOLD,
  circuitAllows,
  cooldownRemainingMs,
  getProviderHealthSnapshot,
  getTtftStats,
  isCoolingDown,
  partitionCooling,
  recordProviderFailure,
  recordProviderSuccess,
  recordTtft,
  resetProviderHealthTracking,
} from '../electron/llm/providers/circuit';

afterEach(() => resetProviderHealthTracking());

const T0 = 1_000_000;

describe('circuit breaker', () => {
  it('starts closed and allows every provider', () => {
    expect(isCoolingDown('openrouter', T0)).toBe(false);
    expect(circuitAllows('openrouter', T0)).toBe(true);
    expect(cooldownRemainingMs('openrouter', T0)).toBe(0);
  });

  it('opens after ALLOWED_FAILS consecutive failures', () => {
    for (let i = 0; i < ALLOWED_FAILS - 1; i++) {
      recordProviderFailure('openrouter', {}, T0 + i);
      expect(isCoolingDown('openrouter', T0 + i)).toBe(false);
    }
    recordProviderFailure('openrouter', {}, T0 + 5);
    expect(isCoolingDown('openrouter', T0 + 6)).toBe(true);
    expect(circuitAllows('openrouter', T0 + 6)).toBe(false);
    // Third failure at T0+5 → openUntil = T0+5+COOLDOWN.
    expect(cooldownRemainingMs('openrouter', T0 + 6)).toBe(COOLDOWN_MS - 1);
  });

  it('a success resets the closed-state failure streak', () => {
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0 + 1);
    recordProviderSuccess('p', T0 + 2);
    recordProviderFailure('p', {}, T0 + 3);
    recordProviderFailure('p', {}, T0 + 4);
    expect(isCoolingDown('p', T0 + 5)).toBe(false);
  });

  it('429 (instant) trips on the first failure', () => {
    recordProviderFailure('p', { instant: true }, T0);
    expect(isCoolingDown('p', T0 + 1)).toBe(true);
  });

  it('never extends an open circuit — repeated failures during cooldown do not push the deadline', () => {
    recordProviderFailure('p', {}, T0); // 1
    recordProviderFailure('p', {}, T0 + 1); // 2
    recordProviderFailure('p', {}, T0 + 2); // 3 → open, openUntil = T0+2+COOLDOWN
    recordProviderFailure('p', {}, T0 + 5_000); // during cooldown
    recordProviderFailure('p', {}, T0 + 10_000); // during cooldown
    expect(cooldownRemainingMs('p', T0 + 2 + COOLDOWN_MS - 1_000)).toBe(1_000);
  });

  it('an elapsed open circuit becomes half-open and allows a probe', () => {
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    const openUntil = T0 + COOLDOWN_MS;
    expect(circuitAllows('p', openUntil)).toBe(true);
    expect(isCoolingDown('p', openUntil)).toBe(false);
    const snap = getProviderHealthSnapshot().find((s) => s.id === 'p');
    expect(snap?.state).toBe('half-open');
  });

  it('a failed half-open probe re-opens for a full cooldown', () => {
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    const probeAt = T0 + COOLDOWN_MS;
    expect(circuitAllows('p', probeAt)).toBe(true);
    recordProviderFailure('p', {}, probeAt + 10);
    expect(isCoolingDown('p', probeAt + 11)).toBe(true);
    // Re-opened at probeAt+10 → openUntil = probeAt+10+COOLDOWN.
    expect(cooldownRemainingMs('p', probeAt + 11)).toBe(COOLDOWN_MS - 1);
  });

  it(`half-open closes only after ${HALF_OPEN_SUCCESS_THRESHOLD} consecutive successes`, () => {
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    const probeAt = T0 + COOLDOWN_MS;
    circuitAllows('p', probeAt);
    recordProviderSuccess('p', probeAt + 1);
    expect(getProviderHealthSnapshot().find((s) => s.id === 'p')?.state).toBe('half-open');
    recordProviderSuccess('p', probeAt + 2);
    expect(getProviderHealthSnapshot().find((s) => s.id === 'p')?.state).toBe('half-open');
    recordProviderSuccess('p', probeAt + 3);
    expect(getProviderHealthSnapshot().find((s) => s.id === 'p')?.state).toBe('closed');
    // Closed again: failures must count from zero, not trip instantly.
    recordProviderFailure('p', {}, probeAt + 4);
    recordProviderFailure('p', {}, probeAt + 5);
    expect(isCoolingDown('p', probeAt + 6)).toBe(false);
  });

  it('tracks attempts and failures per provider', () => {
    recordProviderSuccess('p', T0);
    recordProviderFailure('p', {}, T0 + 1);
    recordProviderFailure('p', {}, T0 + 2);
    const snap = getProviderHealthSnapshot().find((s) => s.id === 'p');
    expect(snap?.attempts).toBe(3);
    expect(snap?.failures).toBe(2);
    expect(snap?.fails).toBe(2);
  });
});

describe('partitionCooling', () => {
  it('keeps order when nothing is cooling', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(partitionCooling(items, (i) => i.id, T0)).toEqual(items);
  });

  it('sinks cooling providers to the back, preserving relative order on both sides', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    recordProviderFailure('a', {}, T0);
    recordProviderFailure('a', {}, T0);
    recordProviderFailure('a', {}, T0);
    recordProviderFailure('c', {}, T0);
    recordProviderFailure('c', {}, T0);
    recordProviderFailure('c', {}, T0);
    const out = partitionCooling(items, (i) => i.id, T0 + 1);
    expect(out.map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('leaves an elapsed cooldown in the ready partition', () => {
    recordProviderFailure('a', {}, T0);
    recordProviderFailure('a', {}, T0);
    recordProviderFailure('a', {}, T0);
    const items = [{ id: 'a' }, { id: 'b' }];
    const out = partitionCooling(items, (i) => i.id, T0 + COOLDOWN_MS);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('TTFT telemetry ring', () => {
  it('reports n / p50 / last', () => {
    recordTtft('p', 100);
    recordTtft('p', 300);
    recordTtft('p', 200);
    const stats = getTtftStats('p');
    expect(stats.n).toBe(3);
    expect(stats.p50).toBe(200);
    expect(stats.last).toBe(200);
  });

  it('caps the ring at 20 samples', () => {
    for (let i = 0; i < 50; i++) recordTtft('p', i);
    const stats = getTtftStats('p');
    expect(stats.n).toBe(20);
    expect(stats.last).toBe(49);
    expect(stats.p50).toBe(40);
  });

  it('ignores invalid samples', () => {
    recordTtft('p', Number.NaN);
    recordTtft('p', -5);
    expect(getTtftStats('p').n).toBe(0);
  });

  it('returns empty stats for an unknown provider', () => {
    expect(getTtftStats('nope')).toEqual({ n: 0, p50: null, last: null });
  });

  it('exposes ttft p50 in the health snapshot', () => {
    recordTtft('p', 400);
    const snap = getProviderHealthSnapshot().find((s) => s.id === 'p');
    expect(snap?.ttftP50Ms).toBe(400);
  });
});

describe('resetProviderHealthTracking', () => {
  it('clears circuits and telemetry', () => {
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    recordProviderFailure('p', {}, T0);
    recordTtft('p', 100);
    resetProviderHealthTracking();
    expect(isCoolingDown('p', T0 + 1)).toBe(false);
    expect(getTtftStats('p').n).toBe(0);
    expect(getProviderHealthSnapshot()).toEqual([]);
  });
});
