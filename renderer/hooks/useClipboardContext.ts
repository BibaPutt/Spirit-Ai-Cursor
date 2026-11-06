import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { ClipboardContext } from '../../electron/types';

export function useClipboardContext() {
  const [ctx, setCtx] = useState<ClipboardContext>({ preview: null, length: 0 });

  useEffect(() => {
    const offCtx = ipc.onClipboardContext((c) => setCtx(c));
    const offEnd = ipc.onAIModeEnd(() => setCtx({ preview: null, length: 0 }));
    return () => {
      offCtx();
      offEnd();
    };
  }, []);

  const dismiss = useCallback(async () => {
    await ipc.dismissClipboard();
    setCtx({ preview: null, length: 0 });
  }, []);

  return { ctx, dismiss };
}
