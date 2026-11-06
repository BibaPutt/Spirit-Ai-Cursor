import { useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { AnnotationStreamPayload, ScreenAnnotation } from '../../electron/types';

type Result = {
  // The FULL accumulated annotation set for the current answer run, in story
  // order (seq ascending). Grows as main streams newly-completed tags; resets
  // to [] on the authoritative clear (submit / final answer / error).
  annotations: ScreenAnnotation[];
};

// Listen for main's annotation stream (Phase 7). Main broadcasts display-local
// [POINT]/[BOX]/[ARROW] targets as the answer streams and an empty payload to
// clear on start/final/error. `seq` is stable and unique per run, so dedupe is
// exact — no double-filings when main remaps a buffer against newer geometry.
// Annotations ride along with the overlay: when the overlay is dismissed or AI
// mode ends, the tags disappear with it (same as useChips/useWebImages).
export function useAnnotations(): Result {
  const [annotations, setAnnotations] = useState<ScreenAnnotation[]>([]);
  const seenRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const offEnd = ipc.onAIModeEnd(() => {
      seenRef.current.clear();
      setAnnotations([]);
    });
    const off = ipc.onAnnotationStream((payload: AnnotationStreamPayload) => {
      if (payload.annotations.length === 0) {
        seenRef.current.clear();
        setAnnotations([]);
        return;
      }
      const fresh: ScreenAnnotation[] = [];
      for (const a of payload.annotations) {
        if (seenRef.current.has(a.seq)) continue;
        seenRef.current.add(a.seq);
        fresh.push(a);
      }
      if (fresh.length > 0) setAnnotations((prev) => [...prev, ...fresh]);
    });
    return () => {
      off();
      offEnd();
      seenRef.current.clear();
    };
  }, []);

  return { annotations };
}