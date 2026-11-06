// LiteLLM-style provider circuit breaker + TTFT telemetry ring — the Spirit
// port of `allowed_fails` / `cooldown_time` / half-open `success_threshold`.
//
// Why: the router already retries a failing provider 5x with backoff (up to
// ~80s) before failover, and then the NEXT submit started that whole storm
// again from scratch. A dead provider was re-burned on every query. This
// module tracks per-provider failure streaks in-memory and puts a short
// cooldown in front of it so the chain skips straight to a healthy lane.
//
// Semantics (mirroring LiteLLM):
//   closed      normal. Consecutive failures counted; at ALLOWED_FAILS (or on
//               an instant-trip error like 429) the circuit OPENs for
//               COOLDOWN_MS.
//   open        every caller skips the provider until openUntil elapses.
//   half-open   once the cooldown elapses, probes are allowed again; three
//               consecutive successes fully close the circuit, any failure
//               re-opens it for another cooldown.
//
// Pure module (no Electron) — vitest drives it directly. State is
// process-local and intentionally NOT persisted: a restart clears cooldowns,
// which is the desired behavior (fresh start, re-probe everything).

export const ALLOWED_FAILS = 3;
export const COOLDOWN_MS = 30_000;
export const HALF_OPEN_SUCCESS_THRESHOLD = 3;
// 429 does not recover by retrying in seconds — trip immediately so the next
// submit never wastes a round on a rate-limited key.
export const INSTANT_TRIP_STATUSES = new Set([429]);
const TTFT_RING_SIZE = 20;

export type CircuitState = 'closed' | 'open' | 'half-open';

type Circuit = {
  state: CircuitState;
  fails: number; // consecutive failures while closed
  openUntil: number; // epoch ms; only meaningful while open
  halfOpenSuccesses: number;
  attempts: number;
  failures: number;
};

const circuits = new Map<string, Circuit>();
const ttftRing = new Map<string, number[]>();

function circuitFor(id: string): Circuit {
  let c = circuits.get(id);
  if (!c) {
    c = { state: 'closed', fails: 0, openUntil: 0, halfOpenSuccesses: 0, attempts: 0, failures: 0 };
    circuits.set(id, c);
  }
  return c;
}

// True while the breaker is OPEN and the cooldown has not elapsed — the
// provider must be skipped by chain walkers. Pure (no state transition).
export function isCoolingDown(id: string, now = Date.now()): boolean {
  const c = circuits.get(id);
  return !!c && c.state === 'open' && now < c.openUntil;
}

// Chain-loop guard: false while cooling; an ELAPSED open circuit flips to
// half-open (probe allowed) as a side effect, so a single call both answers
// "may I try?" and performs the transition.
export function circuitAllows(id: string, now = Date.now()): boolean {
  const c = circuits.get(id);
  if (!c) return true;
  if (c.state === 'open') {
    if (now < c.openUntil) return false;
    c.state = 'half-open';
    c.halfOpenSuccesses = 0;
  }
  return true;
}

function openCircuit(c: Circuit, now: number): void {
  c.state = 'open';
  c.openUntil = now + COOLDOWN_MS;
  c.halfOpenSuccesses = 0;
}

// `instant` = rate-limit style failure (429): trip on the first hit instead
// of waiting for ALLOWED_FAILS. An already-open circuit is never extended —
// repeated failures during cooldown must not push the deadline out forever.
export function recordProviderFailure(
  id: string,
  opts: { instant?: boolean } = {},
  now = Date.now(),
): void {
  const c = circuitFor(id);
  c.attempts++;
  c.failures++;
  if (c.state === 'open') return;
  if (c.state === 'half-open') {
    openCircuit(c, now); // probe failed → straight back to open
    return;
  }
  c.fails++;
  if (opts.instant || c.fails >= ALLOWED_FAILS) openCircuit(c, now);
}

// A completed round (even an empty/unparseable one — the HTTP round itself
// succeeded) resets the closed-state failure streak; while half-open it
// counts toward closing the circuit.
export function recordProviderSuccess(id: string, now = Date.now()): void {
  const c = circuitFor(id);
  c.attempts++;
  if (c.state === 'half-open') {
    c.halfOpenSuccesses++;
    if (c.halfOpenSuccesses >= HALF_OPEN_SUCCESS_THRESHOLD) {
      c.state = 'closed';
      c.fails = 0;
      c.halfOpenSuccesses = 0;
      c.openUntil = 0;
    }
    return;
  }
  c.fails = 0;
}

// Ms left before an open circuit allows a probe (0 when not cooling).
export function cooldownRemainingMs(id: string, now = Date.now()): number {
  const c = circuits.get(id);
  if (!c || c.state !== 'open') return 0;
  return Math.max(0, c.openUntil - now);
}

// Stable partition for chain resolution: healthy providers keep their
// configured relative order up front, cooling-down providers move to the
// back (still present — if everything else fails the loop may probe them
// once their cooldown elapses mid-run, and an all-cooling chain still
// produces a coherent error instead of "no provider configured").
export function partitionCooling<T>(items: T[], idOf: (item: T) => string, now = Date.now()): T[] {
  const ready: T[] = [];
  const cooling: T[] = [];
  for (const item of items) {
    (isCoolingDown(idOf(item), now) ? cooling : ready).push(item);
  }
  return ready.concat(cooling);
}

// TTFT telemetry ring
// Time-to-first-token per provider, last TTFT_RING_SIZE samples. Pure
// observability: feeds future chain ranking and the settings health view;
// never gates a request on its own.

export function recordTtft(id: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const arr = ttftRing.get(id) ?? [];
  arr.push(ms);
  if (arr.length > TTFT_RING_SIZE) arr.shift();
  ttftRing.set(id, arr);
}

export type TtftStats = { n: number; p50: number | null; last: number | null };

export function getTtftStats(id: string): TtftStats {
  const arr = ttftRing.get(id);
  if (!arr || arr.length === 0) return { n: 0, p50: null, last: null };
  const sorted = [...arr].sort((a, b) => a - b);
  return { n: arr.length, p50: sorted[Math.floor(sorted.length / 2)], last: arr[arr.length - 1] };
}

export type ProviderHealthSnapshot = {
  id: string;
  state: CircuitState;
  fails: number;
  cooldownRemainingMs: number;
  attempts: number;
  failures: number;
  ttftP50Ms: number | null;
};

// Point-in-time view for logging / a future settings panel. Includes ids
// that only have TTFT samples (no circuit activity yet).
export function getProviderHealthSnapshot(): ProviderHealthSnapshot[] {
  const ids = new Set([...circuits.keys(), ...ttftRing.keys()]);
  const out: ProviderHealthSnapshot[] = [];
  for (const id of ids) {
    const c = circuits.get(id);
    out.push({
      id,
      state: c?.state ?? 'closed',
      fails: c?.fails ?? 0,
      cooldownRemainingMs: c && c.state === 'open' ? Math.max(0, c.openUntil - Date.now()) : 0,
      attempts: c?.attempts ?? 0,
      failures: c?.failures ?? 0,
      ttftP50Ms: getTtftStats(id).p50,
    });
  }
  return out;
}

// Test hook — wipes breaker + telemetry state between cases.
export function resetProviderHealthTracking(): void {
  circuits.clear();
  ttftRing.clear();
}
