import { useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';

export function useAIMode(): { active: boolean } {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Pull current state to catch any AIModeStart that fired before we
    // registered our listener (common in dev mode where Vite HMR can delay
    // React mounting past the trigger).
    ipc.getAIModeState().then(({ active: s }) => {
      setActive(s);
    }).catch(() => { /* best-effort */ });

    const offStart = ipc.onAIModeStart(() => setActive(true));
    const offEnd = ipc.onAIModeEnd(() => setActive(false));
    return () => {
      offStart();
      offEnd();
    };
  }, []);

  return { active };
}
