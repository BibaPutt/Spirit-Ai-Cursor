// Module-level cursor position store.
//
// The pointer position arrives over IPC at up to 30 Hz whenever AI mode (or
// Settings) is open. Keeping it in React state re-rendered the entire App
// tree — including the 3300-line PromptInput — on every tick, which was one
// of the two measured renderer hotspots (~51-62% CPU with the box open).
//
// This store holds the latest position outside React. Consumers either read
// it once (getCursorPos) or subscribe for live updates (subscribeCursor) —
// the framer-motion follow springs, the bounds kick and the hover hit-test
// all run from the subscription without a single React re-render. The one
// value the UI does need as state (which display owns the box) is derived
// separately in useCursorDisplayId and only changes when the display changes.
import type { CursorPosition } from '../../electron/types';

let current: CursorPosition | null = null;
const listeners = new Set<(p: CursorPosition | null) => void>();

export function setCursorPos(p: CursorPosition | null): void {
  // Dedupe identical positions: main's parked-heartbeat re-broadcasts the
  // same point once a second, and Electron payloads are fresh objects each
  // time — without this every heartbeat would wake every listener.
  if (
    p &&
    current &&
    current.x === p.x &&
    current.y === p.y &&
    current.displayId === p.displayId &&
    current.shape === p.shape &&
    current.scrollbar === p.scrollbar
  ) {
    return;
  }
  current = p;
  for (const l of listeners) l(p);
}

export function getCursorPos(): CursorPosition | null {
  return current;
}

export function subscribeCursor(
  l: (p: CursorPosition | null) => void,
): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
