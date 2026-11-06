import { screen } from 'electron';
import { broadcastCursorPosition } from '../ipc/handlers';
import { probeOnce } from './cursor-shape';
import { adaptivePollMs, getCursorIdleMs, noteCursorMove } from './activity';

// Cursor tracking is DEMAND-driven: each overlay renderer registers itself via
// `cursor:tracking-needed` while it has something to draw from the pointer
// position (AI mode, Settings/Memory modal). With zero consumers the poll loop
// stops entirely, so a fully idle Spirit costs no timer wakeups at all.
//
// While at least one consumer exists the poll rate ADAPTS to movement instead
// of running a fixed 30Hz forever: 30Hz while the pointer moves, ~15Hz after
// it parks for a beat, ~7Hz once it's been still for a while. Interactive
// zones still feel instant on hover, but a parked mouse stops driving 30
// wakeups per second.

const FAST_INTERVAL_MS = 33;
const MID_INTERVAL_MS = 66;
const SLOW_INTERVAL_MS = 150;

// Synthetic consumer id used by the explicit startCursorTracking() API
// (main.ts before-quit path and any force-on callers).
const FORCED_CONSUMER = -1;

const consumers = new Set<number>();

let timer: NodeJS.Timeout | null = null;
let lastX = -1;
let lastY = -1;
let lastDisplayId = -1;
let lastBroadcastAt = 0;
// Heartbeat while parked: an unmoved cursor still re-broadcasts every second
// so renderers can tell "parked" from "tracking died". Without it a dead loop
// left a stale pos holding fullscreen capture on the wrong display forever.
const PARKED_HEARTBEAT_MS = 1000;

function tick(): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const now = Date.now();
  if (cursor.x === lastX && cursor.y === lastY && display.id === lastDisplayId) {
    if (now - lastBroadcastAt < PARKED_HEARTBEAT_MS) return;
  }
  lastX = cursor.x;
  lastY = cursor.y;
  lastDisplayId = display.id;
  lastBroadcastAt = now;
  noteCursorMove();
  broadcastCursorPosition();
}

function pollIntervalMs(): number {
  return adaptivePollMs(getCursorIdleMs(), FAST_INTERVAL_MS, MID_INTERVAL_MS, SLOW_INTERVAL_MS);
}

function loop(): void {
  timer = null;
  if (consumers.size === 0) return;
  tick();
  // Fire-and-forget: probeOnce() self-throttles (skips if <45ms since last
  // probe, skips if cursor hasn't moved, skips if capture mode is off) so
  // it naturally limits itself at our adaptive cadence.
  void probeOnce();
  timer = setTimeout(loop, pollIntervalMs());
}

function sync(): void {
  if (consumers.size > 0) {
    if (!timer) {
      lastX = -1;
      lastY = -1;
      lastDisplayId = -1;
      // Immediate position so a consumer (e.g. Settings opened from the tray)
      // has a valid cursor from frame one, then start the adaptive loop.
      broadcastCursorPosition();
      timer = setTimeout(loop, 0);
    }
  } else if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// Register/unregister a consumer (webContents id from the renderer). When the
// last consumer drops, tracking stops until someone needs it again.
export function setCursorTrackingNeeded(senderId: number, needed: boolean): void {
  if (needed) consumers.add(senderId);
  else consumers.delete(senderId);
  sync();
}

export function startCursorTracking(): void {
  consumers.add(FORCED_CONSUMER);
  sync();
}

export function stopCursorTracking(): void {
  consumers.delete(FORCED_CONSUMER);
  sync();
}

export function isCursorTrackingActive(): boolean {
  return timer !== null;
}
