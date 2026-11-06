import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { LinkMeta } from '../../electron/types';

const URL_RE = /https?:\/\/[^\s)<>"'`,]+/g;
const MAX_LINKS = 6;

export function useLinkMetas(text: string, ready: boolean) {
  const [metas, setMetas] = useState<Record<string, LinkMeta>>({});
  const fetched = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ready || !text) return;
    const urls = uniqueUrls(text).slice(0, MAX_LINKS);
    for (const url of urls) {
      if (fetched.current.has(url)) continue;
      fetched.current.add(url);
      void (async () => {
        try {
          const meta = await ipc.fetchLinkMeta(url);
          if (meta) {
            setMetas((prev) => ({ ...prev, [url]: meta }));
          }
        } catch {
          /* swallow */
        }
      })();
    }
  }, [text, ready]);

  // Stable identity (useCallback) and no-op when already empty. Without these
  // two guards the calling component's `useEffect([hasResponse, resetMetas])`
  // saw a fresh `reset` reference every render — which fired resetMetas →
  // setMetas({}) (always a new {} object → state change) → re-render → NEW
  // resetMetas identity → infinite render loop. React then printed the
  // "Maximum update depth exceeded" warning every frame and the box flickered
  // because it never got to settle on a layout.
  const reset = useCallback(() => {
    setMetas((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    if (fetched.current.size > 0) fetched.current = new Set();
  }, []);

  return { metas, reset };
}

function uniqueUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const cleaned = matches.map((m) => m.replace(/[.,;:!?)]+$/, ''));
  return Array.from(new Set(cleaned));
}
