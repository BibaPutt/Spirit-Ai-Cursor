// Degenerate-loop guards — the Spirit port of GenOffice's `MAX_IDENTICAL_TURNS`,
// `MAX_ALL_ERROR_TURNS` and `MAX_INPUT_PARSE_RETRIES` caps in agent-core.
//
// router.ts already bounds rounds (MAX_ROUNDS=8), screenshots, info lookups and
// per-action retries, but has no RUN-level detector for the two cheapest ways a
// weak model wastes the budget: re-emitting the SAME tool round over and over
// (repeat-after-success), and hammering an action that keeps failing. These pure
// helpers count the streaks; the router decides when to finalize honestly.
//
// Pure module (no Electron, no provider) so vitest can drive it directly.

export const MAX_IDENTICAL_ROUNDS = 3;
export const MAX_ALL_ERROR_ROUNDS = 4;
export const MAX_BAD_INPUT_ROUNDS = 3;

// Deterministic canonical shape of one tool round, order-insensitive, so
// `ui_click(a)` + `web_search(q)` is the same round as `web_search(q)` +
// `ui_click(a)`.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function toolRoundFingerprint(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): string {
  const parts = calls
    .map((c) => `${c.name}(${stableJson(c.args ?? {})})`)
    .sort();
  return parts.join(' | ');
}

// Identical-turn counter: bump when the round's fingerprint repeats the
// previous round's, reset to 1 on any change (empty fingerprints never count).
export function nextIdenticalStallCount(
  prev: number,
  fingerprint: string,
  lastFingerprint: string | null,
): number {
  if (fingerprint.length === 0) return 0;
  return lastFingerprint === fingerprint ? prev + 1 : 1;
}

export function isIdenticalStallHit(count: number): boolean {
  return count >= MAX_IDENTICAL_ROUNDS;
}

// All-error streak: every executed call in the round failed. Resets to 0 on any
// round where something executed successfully, or where nothing executed.
export function nextAllErrorStreak(
  prev: number,
  toolCalls: number,
  executed: number,
  failures: number,
): number {
  if (toolCalls === 0 || executed === 0 || failures === 0) return 0;
  return executed === failures ? prev + 1 : 0;
}

export function isAllErrorStreakHit(streak: number): boolean {
  return streak >= MAX_ALL_ERROR_ROUNDS;
}

// Bad-tool-input streak: a round made up entirely of unparseable / truncated
// tool calls (nothing executed, nothing to fail). The router keeps feeding the
// targeted "fix your JSON" feedback; past the cap it finalizes honestly.
export function nextBadInputStreak(
  prev: number,
  toolCalls: number,
  badInput: number,
  executed: number,
): number {
  if (toolCalls === 0 || badInput === 0 || executed > 0) return 0;
  return badInput >= toolCalls ? prev + 1 : 0;
}

export function isBadInputStreakHit(streak: number): boolean {
  return streak >= MAX_BAD_INPUT_ROUNDS;
}