import { useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';

// Foreground-app preview ("Microsoft Edge · weather - Google Search"),
// broadcast at trigger and on each send by the main process. Always-on
// context (no dismiss). Cleared when AI mode ends.
export function useAppContext() {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const offCtx = ipc.onAppContext((p) => setPreview(p));
    const offEnd = ipc.onAIModeEnd(() => setPreview(null));
    return () => {
      offCtx();
      offEnd();
    };
  }, []);

  return preview;
}
