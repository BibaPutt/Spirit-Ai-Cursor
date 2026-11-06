import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { WebImage } from '../../electron/types';

const MAX_ROW_IMAGES = 6;

// Web images pushed by the main process: each [IMAGE] <subject> line in the
// answer makes main search the real backends and broadcast the pictures here.
// Results from several subjects (the model may name 2–3 angles of the same
// thing) accumulate into one deduped row shown above the answer. Cleared on
// AI-mode end; a submit clears the row immediately (main also broadcasts []
// when cancelling).
export function useWebImages() {
  const [images, setImages] = useState<WebImage[]>([]);

  useEffect(() => {
    const offResult = ipc.onWebImagesResult((result) => {
      setImages((prev) => {
        // An empty broadcast means "a new answer started / the row was cleared"
        // — replace the row instead of appending to the previous answer's images.
        if (result.length === 0) return [];
        const seen = new Set(prev.map((im) => im.url));
        const next = prev.slice();
        for (const im of result) {
          if (next.length >= MAX_ROW_IMAGES) break;
          if (!seen.has(im.url)) {
            seen.add(im.url);
            next.push(im);
          }
        }
        return next;
      });
    });
    const offEnd = ipc.onAIModeEnd(() => setImages([]));
    return () => {
      offResult();
      offEnd();
    };
  }, []);

  const clear = useCallback(() => setImages([]), []);

  return { images, clear };
}
