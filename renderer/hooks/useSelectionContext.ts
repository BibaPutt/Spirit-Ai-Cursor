import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { SelectionContext } from '../../electron/types';

export function useSelectionContext() {
  const [ctx, setCtx] = useState<SelectionContext>({ preview: null, length: 0 });

  useEffect(() => {
    const offCtx = ipc.onSelectionContext((c) => setCtx(c));
    const offEnd = ipc.onAIModeEnd(() => setCtx({ preview: null, length: 0 }));
    return () => {
      offCtx();
      offEnd();
    };
  }, []);

  const dismiss = useCallback(async () => {
    await ipc.dismissSelection();
    setCtx({ preview: null, length: 0 });
  }, []);

  return { ctx, dismiss };
}
