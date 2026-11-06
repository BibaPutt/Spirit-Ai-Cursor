import { useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';
import { setCursorPos } from '../lib/cursorStore';
import type { CursorPosition } from '../../electron/types';

// Cursor position is deliberately NOT React state. It arrives up to 30×/s
// while AI mode is open; routing it through useState re-rendered the whole
// App tree (and the huge PromptInput) on every tick — a measured hotspot.
// Each position is pushed into the module store (lib/cursorStore) instead;
// the only thing this hook exposes as state is the DISPLAY id, which changes
// at most once per pointer move between monitors and is what App needs to
// decide which overlay renders the box.
export function useCursorDisplayId(): number | null {
  const [displayId, setDisplayId] = useState<number | null>(null);

  useEffect(() => {
    const update = (p: CursorPosition) => {
      setCursorPos(p);
      setDisplayId((prev) => (prev === p.displayId ? prev : p.displayId));
    };
    const offStart = ipc.onAIModeStart(update);
    const offCursor = ipc.onCursorPosition(update);
    const offEnd = ipc.onAIModeEnd(() => {
      setCursorPos(null);
      setDisplayId(null);
    });
    return () => {
      offStart();
      offCursor();
      offEnd();
    };
  }, []);

  return displayId;
}
