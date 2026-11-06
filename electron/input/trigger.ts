import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi';
import { screen } from 'electron';
import { getInputTuning } from '../store/settings';
import { noteMousedown } from './forward-tracker';
import { wiggleTuningForLevel, type WiggleTuning } from './wiggle-tuning';

const HOLD_KEY_MS = 200;
const RIGHT_MOUSE_BUTTON = 2;
const LEFT_MOUSE_BUTTON = 1;
const DOUBLE_CLICK_MS = 800;
const OUTSIDE_HALO_PX = 14;

// Active-box bounds in display-local coords. Renderer pushes these whenever
// the box position changes (it's draggable). When set, a left mouse click
// outside these bounds during AI mode counts towards the dismiss-by-click
// gesture — single or double depending on settings.dismissOnDoubleClick.
type BoxBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  displayId: number;
};
let activeBoxBounds: BoxBounds | null = null;
let lastOutsideClickMs = 0;

export function setActiveBoxBounds(b: BoxBounds | null): void {
  activeBoxBounds = b;
  // Only reset the double-click accumulator when the box truly goes away
  // (renderer sent null). Resetting it on every bounds update was a bug —
  // the renderer pushes bounds at ~60fps via requestAnimationFrame, which
  // wiped lastOutsideClickMs between click 1 and click 2 every single time
  // and made "click outside to dismiss" effectively impossible to trigger.
  if (b === null) lastOutsideClickMs = 0;
}

// Displays where the overlay is in custom-cursor "capture mode": the overlay
// owns the mouse full-time while AI mode is active, so the renderer's DOM
// handles outside-click dismissal AND forwards the click to the app beneath.
// Main must therefore skip its own uiohook outside-click handling on those
// displays, or a single outside click would be counted twice (uiohook + DOM)
// and the box would dismiss on the first click regardless of the
// dismissOnDoubleClick setting. Also suppresses re-entry from the synthetic
// mouse events main posts while forwarding.
const captureModeDisplays = new Set<number>();

export function setCaptureMode(displayId: number, on: boolean): void {
  if (on) captureModeDisplays.add(displayId);
  else captureModeDisplays.delete(displayId);
}

// The custom-cursor probe only runs while at least one display is in capture
// mode — the only time the OS arrow is hidden and SpiritCursor is visible.
export function isCaptureModeActive(): boolean {
  return captureModeDisplays.size > 0;
}

// User-selectable trigger. Read from settings every keydown so settings
// changes take effect immediately without restarting the app.
//
// Each hotkey id maps to ONE OR MORE keycodes. The *Either*
// entries listen to both sides simultaneously so a user who finds the
// right-Cmd inconvenient can keep their muscle memory while also
// allowing the left-Cmd to fire Spirit. This is "additional
// listening", NOT OS-level reservation — uIOhook observes events; it
// doesn't suppress them. Other apps that consume left-Cmd (Cmd+C,
// Cmd+Tab, etc.) continue to work as before.
const HOTKEY_MAP: Record<string, number[]> = {
  MetaRight: [UiohookKey.MetaRight],
  CtrlRight: [UiohookKey.CtrlRight],
  AltRight: [UiohookKey.AltRight],
  ShiftRight: [UiohookKey.ShiftRight],
  MetaLeft: [UiohookKey.Meta],
  CtrlLeft: [UiohookKey.Ctrl],
  AltLeft: [UiohookKey.Alt],
  ShiftLeft: [UiohookKey.Shift],
  MetaEither: [UiohookKey.MetaRight, UiohookKey.Meta],
  CtrlEither: [UiohookKey.CtrlRight, UiohookKey.Ctrl],
};

function currentTriggerKeycodes(): number[] {
  const hk = getInputTuning().triggerHotkey;
  return HOTKEY_MAP[hk] ?? (process.platform === 'darwin' ? [UiohookKey.MetaRight] : [UiohookKey.CtrlRight]);
}

function isTriggerKey(keycode: number): boolean {
  return currentTriggerKeycodes().includes(keycode);
}

type State = 'idle' | 'pending' | 'active';
type PendingKind = 'key' | 'mouse';

type Listeners = {
  onStart: () => void;
  onEnd: (reason?: string) => void;
  // Fired when the trigger key is pressed AGAIN while the box is already
  // open. We use that as a "modifier" to switch the overlay into selection-
  // capture mode: hold the trigger key + drag → defines a rectangle for
  // an ad-hoc screenshot. Lets users keep click-through to background apps
  // for normal mouse work while still having a clean way to escape into
  // selection mode on demand.
  onSelectionArm?: (armed: boolean) => void;
  // Fired when the user engages outside our box — either a printable
  // non-trigger keystroke (kind='key') or an outside mousedown (kind='click').
  // The renderer disambiguates: 'click' always counts toward dismiss, but
  // 'key' is suppressed when our own input has DOM+OS focus (the user is
  // typing into the Big Pill, not into another app).
  onExternalTyping?: (kind: 'key' | 'click') => void;
};

let state: State = 'idle';
let pendingTimer: NodeJS.Timeout | null = null;
let pendingKind: PendingKind | null = null;
let listeners: Listeners | null = null;
let attached = false;
let selectionArmed = false;
// True between the moment the trigger key is pressed and the moment it
// is released. We use this in the pending-timer callback so that a user
// who simply KEEPS HOLDING the trigger past HOLD_KEY_MS gets selection
// mode armed in the same gesture — instead of having to release and
// re-press the key just to draw a rectangle. Matches the natural
// "press and hold to drag-crop" muscle memory of macOS Spotlight crop
// (Shift+Cmd+4 holding shift) and Windows Snip & Sketch.
let triggerKeyHeld = false;

function clearPending(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingKind = null;
  if (state === 'pending') state = 'idle';
}

function fireStart(): void {
  if (state === 'active') return;
  state = 'active';
  listeners?.onStart();
}

function fireEnd(reason = 'unknown'): void {
  if (state !== 'active') return;
  state = 'idle';
  if (selectionArmed) {
    selectionArmed = false;
    listeners?.onSelectionArm?.(false);
  }
  listeners?.onEnd(reason);
}

// Throttle for external-typing broadcasts. Users type fast (>50 chars/s
// in a sprint); we don't need to wake the renderer per stroke, we just
// need ONE event per typing burst to know "the user is busy elsewhere".
// 350ms keeps the latency low enough that the renderer reacts while the
// user is still typing, not seconds after they stop.
const EXTERNAL_TYPING_THROTTLE_MS = 350;
let lastExternalTypingEmitTs = 0;

// Keycodes that should NOT count as "user is typing in another app".
// Standalone modifier presses, arrow / function / nav keys, lock keys,
// and OS-level shortcuts (Cmd+Tab, Cmd+Space) are noise — they don't
// mean the user is focused on a textfield.
const NON_TYPING_KEYCODES = new Set<number>([
  UiohookKey.Escape,
  UiohookKey.Tab,
  UiohookKey.CapsLock,
  UiohookKey.Shift, UiohookKey.ShiftRight,
  UiohookKey.Ctrl, UiohookKey.CtrlRight,
  UiohookKey.Alt, UiohookKey.AltRight,
  UiohookKey.Meta, UiohookKey.MetaRight,
  UiohookKey.ArrowUp, UiohookKey.ArrowDown,
  UiohookKey.ArrowLeft, UiohookKey.ArrowRight,
  UiohookKey.Home, UiohookKey.End,
  UiohookKey.PageUp, UiohookKey.PageDown,
  UiohookKey.Insert, UiohookKey.Delete,
  UiohookKey.F1, UiohookKey.F2, UiohookKey.F3, UiohookKey.F4,
  UiohookKey.F5, UiohookKey.F6, UiohookKey.F7, UiohookKey.F8,
  UiohookKey.F9, UiohookKey.F10, UiohookKey.F11, UiohookKey.F12,
]);

function maybeBroadcastExternalTyping(e: UiohookKeyboardEvent): void {
  // Previously gated on `state === 'idle'` but the user expects
  // the big pill to react when they type elsewhere too. The renderer
  // is the smarter gate now: it checks whether OUR input is focused
  // before reacting to this event. Main emits regardless of state and
  // lets the renderer decide intent.
  if (isTriggerKey(e.keycode)) return;          // it's OUR key
  if (NON_TYPING_KEYCODES.has(e.keycode)) return;
  // Skip while a modifier is down — these are usually OS shortcuts,
  // not editing keystrokes. uIOhook reports each key in isolation so
  // we use the raw event flags it surfaces.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const now = Date.now();
  if (now - lastExternalTypingEmitTs < EXTERNAL_TYPING_THROTTLE_MS) return;
  lastExternalTypingEmitTs = now;
  listeners?.onExternalTyping?.('key');
}

function onKeydown(e: UiohookKeyboardEvent): void {
  if (e.keycode === UiohookKey.Escape) {
    if (state === 'active') fireEnd('escape');
    else clearPending();
    return;
  }
  if (!isTriggerKey(e.keycode)) {
    // Non-trigger printable keys while idle = user is typing somewhere
    // else. Broadcast (throttled) so the renderer can react.
    maybeBroadcastExternalTyping(e);
    return;
  }
  triggerKeyHeld = true;
  // Trigger-key pressed while the box is already open → arm selection mode.
  // The renderer listens for this and force-makes the overlay interactive so
  // the drag rectangle handler can fire. Releasing the key disarms.
  if (state === 'active') {
    if (!selectionArmed) {
      selectionArmed = true;
      listeners?.onSelectionArm?.(true);
    }
    return;
  }
  if (state !== 'idle') return;
  state = 'pending';
  pendingKind = 'key';
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    pendingKind = null;
    fireStart();
    // If the user is still holding the trigger key when the box opens
    // (the common "press and hold to crop" gesture), immediately arm
    // selection mode so they can drag a rectangle without releasing +
    // re-pressing the key. Without this gate the user has to do an
    // awkward two-step (press → release → press-again → drag).
    if (triggerKeyHeld && !selectionArmed) {
      selectionArmed = true;
      listeners?.onSelectionArm?.(true);
    }
  }, HOLD_KEY_MS);
}

function onKeyup(e: UiohookKeyboardEvent): void {
  if (!isTriggerKey(e.keycode)) return;
  triggerKeyHeld = false;
  if (selectionArmed) {
    selectionArmed = false;
    listeners?.onSelectionArm?.(false);
  }
  if (state === 'pending' && pendingKind === 'key') {
    clearPending();
  }
}

function onMousedown(e: UiohookMouseEvent): void {
  // Left-mouse click outside the box during AI mode → dismiss accumulator.
  // Settings controls single- vs. double-click.
  if (e.button === LEFT_MOUSE_BUTTON && state === 'active' && activeBoxBounds) {
    // Capture mode: the overlay is interactive, so the renderer's DOM
    // already handled this click (dismiss + forward). Skipping here avoids
    // double-counting the click and lets the forwarded synthetic events
    // (which also fire this hook) pass through without dismissing.
    if (captureModeDisplays.has(activeBoxBounds.displayId)) {
      // One exception: a click that lands while a click-forward is being
      // synthesized. The overlay is click-through for that moment, so the
      // DOM misses it — the second click of a fast double-click would
      // never be counted and the box would never close. uiohook still sees
      // it; noteMousedown counts it and subtracts the synthetic echoes we
      // post ourselves, firing onForwardedClickEaten for any surplus.
      // Clicks inside the box are never dismiss clicks, even when eaten.
      if (!cursorInsideBox()) noteMousedown();
      return;
    }
    handleOutsideClick();
    return;
  }

  // Right-mouse does NOTHING here: right-click long-press used to trigger AI
  // mode from idle, but it fired on ordinary right-clicks (context menus),
  // so the gesture is removed. Hotkey + mouse-wiggle remain the triggers.
  if (e.button !== RIGHT_MOUSE_BUTTON) return;
}

// Whether the cursor currently sits inside the active box bounds (with the
// same OUTSIDE_HALO_PX halo handleOutsideClick uses). Shared by the capture
// mode's eaten-click accounting: a click that was swallowed by the forward's
// click-through window only counts toward dismissal if it was OUTSIDE the
// box — clicking the box itself is never a dismiss gesture.
function cursorInsideBox(): boolean {
  const bounds = activeBoxBounds;
  if (!bounds) return false;
  let cursor: Electron.Point;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    return false;
  }
  const display = screen.getDisplayNearestPoint(cursor);
  if (display.id !== bounds.displayId) return false;
  const lx = cursor.x - display.workArea.x;
  const ly = cursor.y - display.workArea.y;
  return (
    lx >= bounds.left - OUTSIDE_HALO_PX &&
    lx <= bounds.right + OUTSIDE_HALO_PX &&
    ly >= bounds.top - OUTSIDE_HALO_PX &&
    ly <= bounds.bottom + OUTSIDE_HALO_PX
  );
}

function handleOutsideClick(): void {
  if (!activeBoxBounds) return;
  let cursor: Electron.Point;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch {
    return;
  }
  const display = screen.getDisplayNearestPoint(cursor);
  let inside = false;
  if (display.id === activeBoxBounds.displayId) {
    const lx = cursor.x - display.workArea.x;
    const ly = cursor.y - display.workArea.y;
    inside =
      lx >= activeBoxBounds.left - OUTSIDE_HALO_PX &&
      lx <= activeBoxBounds.right + OUTSIDE_HALO_PX &&
      ly >= activeBoxBounds.top - OUTSIDE_HALO_PX &&
      ly <= activeBoxBounds.bottom + OUTSIDE_HALO_PX;
  }
  if (inside) {
    lastOutsideClickMs = 0;
    return;
  }
  // Outside the box. Tell the renderer the user is doing something
  // else; it accumulates these signals and auto-dismisses the prompt box
  // after either 3+ external clicks or ~4s of sustained external focus.
  // This is in addition to the existing single- or double-click dismiss
  // behavior driven by `dismissOnDoubleClick`.
  listeners?.onExternalTyping?.('click');
  // Outside the box. Single- or double-click based on user setting.
  const requireDouble = getInputTuning().dismissOnDoubleClick !== false;
  if (!requireDouble) {
    fireEnd('outside-single');
    return;
  }
  const now = Date.now();
  if (now - lastOutsideClickMs < DOUBLE_CLICK_MS) {
    fireEnd('outside-double');
    lastOutsideClickMs = 0;
  } else {
    lastOutsideClickMs = now;
  }
}

function onMouseup(e: UiohookMouseEvent): void {
  if (e.button !== RIGHT_MOUSE_BUTTON) return;
  if (state === 'pending' && pendingKind === 'mouse') {
    clearPending();
  }
}

// Mouse-wiggle activation. Loosened thresholds + per-reversal
// timing so the detector fires reliably on the natural "shake-the-mouse"
// gesture without false-positives during normal pointer use.
//
// Sensitivity (Settings → Behaviour → Wiggle sensitivity) scales the three
// knobs together. `high` is the loosest tuning (easily triggered);
// `low` needs a bigger, more deliberate shake.
//
// Tuning rationale:
//   - Window grew 700ms → 1100ms: users naturally take ~3 small waggles
//     to mean "hey", that's closer to 1s than 700ms on average input.
//   - Amplitude dropped 60px → 45px: trackpad users don't move far per
//     leg; 60 was too greedy for laptop-only setups.
//   - Throttle removed: the every-3rd-sample skip thinned the buffer
//     enough on trackpad input (120 Hz raw → 40 Hz processed) that a
//     fast waggle missed reversals.
// dt now measured across only the LAST WIGGLE_MIN_REVERSALS leg
//     extremes, not the whole buffer. Earlier code used buffer-span,
//     so a still-cursor sample from 1100ms ago invalidated a fresh
//     800ms wiggle even though the wiggle itself was within window.
// (Historical defaults now live as WIGGLE_TUNING_HIGH in ./wiggle-tuning;
// the `high` sensitivity level reproduces them exactly.)
const WIGGLE_SAMPLE_TTL_MS = 1500;
const WIGGLE_MAX_SAMPLES = 240;

// Sensitivity wrapper: feeds the stored setting into the pure table.
// Defaults to the easily-triggered tuning when settings are unreadable.
function wiggleTuning(): WiggleTuning {
  try {
    return wiggleTuningForLevel(getInputTuning().wiggleSensitivity);
  } catch {
    return wiggleTuningForLevel(undefined);
  }
}
type WiggleSample = { x: number; t: number };
let wiggleSamples: WiggleSample[] = [];

function onMousemove(e: UiohookMouseEvent): void {
  if (state !== 'idle') return;
  let mouseWiggleEnabled = true;
  try {
    mouseWiggleEnabled = getInputTuning().mouseWiggleEnabled !== false;
  } catch {
    /* fall through */
  }
  if (!mouseWiggleEnabled) {
    if (wiggleSamples.length) wiggleSamples = [];
    return;
  }
  const now = Date.now();
  wiggleSamples.push({ x: e.x, t: now });
  while (wiggleSamples.length && now - wiggleSamples[0].t > WIGGLE_SAMPLE_TTL_MS) {
    wiggleSamples.shift();
  }
  if (wiggleSamples.length > WIGGLE_MAX_SAMPLES) {
    wiggleSamples.splice(0, wiggleSamples.length - WIGGLE_MAX_SAMPLES);
  }
  if (wiggleSamples.length < 4) return;

  const tuning = wiggleTuning();
  // Walk the buffer building an "extremes" list — the x-positions where
  // direction reversed by at least the tuned amplitude. The wiggle
  // fires when the last reversals+1 extremes span ≤ tuned window.
  // This decouples the recency check from older sit-still samples in the
  // buffer — the gesture is graded by how fast THE WIGGLE itself was,
  // not by how long ago the sample buffer started.
  type Extreme = { x: number; t: number };
  const extremes: Extreme[] = [{ x: wiggleSamples[0].x, t: wiggleSamples[0].t }];
  let dir: 1 | -1 | 0 = 0;
  let lastExtremeX = wiggleSamples[0].x;
  for (let i = 1; i < wiggleSamples.length; i++) {
    const dx = wiggleSamples[i].x - lastExtremeX;
    if (Math.abs(dx) < tuning.amplitudePx) continue;
    const nd: 1 | -1 = dx > 0 ? 1 : -1;
    if (dir !== 0 && nd !== dir) {
      extremes.push({ x: wiggleSamples[i].x, t: wiggleSamples[i].t });
    } else if (dir === 0) {
      extremes.push({ x: wiggleSamples[i].x, t: wiggleSamples[i].t });
    }
    dir = nd;
    lastExtremeX = wiggleSamples[i].x;
  }
  // Reversal count = transitions between extremes excluding the seed.
  const reversals = Math.max(0, extremes.length - 2);
  if (reversals < tuning.reversals) return;
  // Time span of just the last (reversals + 1) extremes — the
  // most recent waggle. If that span is within window, fire.
  const tailStart = extremes[extremes.length - 1 - tuning.reversals];
  const tailEnd = extremes[extremes.length - 1];
  if (tailEnd.t - tailStart.t <= tuning.windowMs) {
    wiggleSamples = [];
    fireStart();
  }
}

export function startTriggerDetection(l: Listeners): void {
  if (attached) return;
  listeners = l;
  uIOhook.on('keydown', onKeydown);
  uIOhook.on('keyup', onKeyup);
  uIOhook.on('mousedown', onMousedown);
  uIOhook.on('mouseup', onMouseup);
  uIOhook.on('mousemove', onMousemove);
  attached = true;
}

export function stopTriggerDetection(): void {
  if (!attached) return;
  uIOhook.off('keydown', onKeydown);
  uIOhook.off('keyup', onKeyup);
  uIOhook.off('mousedown', onMousedown);
  uIOhook.off('mouseup', onMouseup);
  uIOhook.off('mousemove', onMousemove);
  attached = false;
  clearPending();
  state = 'idle';
  listeners = null;
  wiggleSamples = [];
}

export function endAIMode(reason = 'manual'): void {
  fireEnd(reason);
}

export function startAIModeManually(): void {
  if (state === 'active') return;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingKind = null;
  fireStart();
}

export function getAIModeState(): State {
  return state;
}
