// Forward-synthesis accounting for capture mode.
//
// While the overlay is interactive (capture mode) an outside click is
// forwarded to the app underneath. Forwarding requires temporarily making
// every overlay click-through (withOverlaysClickThrough), and during that
// window a physical second click of a fast double-click passes straight
// through the overlay — the renderer's DOM never sees it, so its
// double-click-to-dismiss counter stays at 1 and the box never closes.
//
// uiohook sees EVERY physical click regardless of window hit-testing, so
// main can catch the swallowed click here: it counts all left-mousedowns
// that arrive while a forward synthesis is in flight and subtracts the
// known synthetic echoes it posted itself (1 per clickAt, 2 for a double).
// Any surplus is a real click that got eaten — trigger.ts fires
// onForwardedClickEaten so the renderer bumps its dismiss counter for it.
//
// Accounting is per mousedown (button press). Each synthesized click posts
// exactly one mousedown, so expectedDowns is simply the click count.

let inFlight = 0; // forward syntheses currently running
let expectedDowns = 0; // synthetic mousedowns we initiated in the current window
let observedDowns = 0; // all mousedowns delivered during the current window
let onForwardedClickEaten: ((count: number) => void) | null = null;

export function setForwardedClickEatenHandler(cb: (count: number) => void): void {
  onForwardedClickEaten = cb;
}

// Call before a click synthesis begins. `clickCount` is the number of
// synthetic clicks that will be posted (1 for clickAt, 2 for a double).
export function beginForward(clickCount: number): void {
  if (inFlight === 0) {
    expectedDowns = 0;
    observedDowns = 0;
  }
  expectedDowns += Math.max(1, Math.floor(clickCount));
  inFlight++;
}

// Call once the synthesis has finished (click-through restored).
export function endForward(): void {
  if (inFlight <= 0) return;
  inFlight--;
  if (inFlight === 0) settle();
}

// Called from uiohook onMousedown while AI mode is active on a capture
// display. Counts downs that arrive during a forward window. Returns true
// when the down was part of that window (a synthetic echo or a physical
// click eaten by the temporary click-through); false when no forward was
// in flight, meaning the interactive overlay's DOM saw the click normally.
export function noteMousedown(): boolean {
  if (inFlight === 0) return false;
  observedDowns++;
  return true;
}

function settle(): void {
  const extra = observedDowns - expectedDowns;
  observedDowns = 0;
  expectedDowns = 0;
  if (extra > 0) onForwardedClickEaten?.(extra);
}
