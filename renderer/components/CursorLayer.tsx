import { useSyncExternalStore } from 'react';
import { AnimatePresence } from 'framer-motion';
import { CursorHalo } from './CursorHalo';
import { SpiritCursor } from './SpiritCursor';
import { getCursorPos, subscribeCursor } from '../lib/cursorStore';
import type { CursorPosition } from '../../electron/types';

// Owns the cursor-tracking visuals (CursorHalo + SpiritCursor) and is the
// ONLY place that re-renders on pointer movement. Previously the cursor
// position was App-level state, so every 30 Hz tick re-rendered the entire
// App tree (1900+ lines) plus the 3300-line PromptInput — the biggest
// renderer CPU drain measured with the box open. Isolating the render here
// means a pointer move re-renders just these two leaf components; App itself
// never re-renders on cursor movement.
function useCursorPos(): CursorPosition | null {
  return useSyncExternalStore(subscribeCursor, getCursorPos, () => null);
}

export function CursorLayer({
  showHalo,
  cursorTakeover,
  captureActive,
  paintArmed,
}: {
  showHalo: boolean;
  cursorTakeover: boolean;
  captureActive: boolean;
  paintArmed: boolean;
}) {
  const pos = useCursorPos();

  return (
    <>
      <AnimatePresence>
        {showHalo && pos && <CursorHalo key="halo" x={pos.x} y={pos.y} />}
      </AnimatePresence>
      <AnimatePresence>
        {cursorTakeover && pos && (
          <SpiritCursor
            key="spirit-cursor"
            x={pos.x}
            y={pos.y}
            // While the user is actively painting, show the Bibata crosshair
            // (Cross.cur) for precision; otherwise mirror the probed app shape.
            shape={captureActive ? pos.shape : undefined}
            scrollbar={pos.scrollbar}
            forceShape={paintArmed ? 'cross' : undefined}
          />
        )}
      </AnimatePresence>
    </>
  );
}
