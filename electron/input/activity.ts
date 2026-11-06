// Shared cursor-activity bookkeeping for the adaptive polling loops. The
// cursor poll and the cursor-shape probe both need to know "how long has the
// pointer been parked?" so they can run fast while it moves and back off (or
// go fully dormant) when it doesn't. Keeping the stamp in one module avoids a
// circular import between cursor.ts and cursor-shape.ts.

let lastMoveAt = 0;

export function noteCursorMove(): void {
  lastMoveAt = Date.now();
}

export function getLastCursorMoveAt(): number {
  return lastMoveAt;
}

export function getCursorIdleMs(): number {
  return Date.now() - lastMoveAt;
}

// Adaptive poll cadence: fast while the pointer is actively moving, then two
// backoff steps as it sits still. The movement windows are short enough that
// hover still feels instant the moment the pointer twitches.
export function adaptivePollMs(
  idleMs: number,
  fastMs: number,
  midMs: number,
  slowMs: number,
  fastWindowMs = 1500,
  midWindowMs = 8000,
): number {
  if (idleMs < fastWindowMs) return fastMs;
  if (idleMs < midWindowMs) return midMs;
  return slowMs;
}
