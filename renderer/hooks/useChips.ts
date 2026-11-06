import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { SuggestionChip } from '../../electron/types';

// Premade (offline) chips must stay on screen for at least this long before
// the AI chips swap in — otherwise a fast generation round swaps the row to
// new content almost instantly and it looks like it's flickering. Keeps the
// premade row for the full ~5-10s a real generation "feels like" it takes.
const MIN_CHIP_DISPLAY_MS = 8000;

// Live action-suggestion chips broadcast by the main process.
//
// `chips`    — context chips for the box-open (OCR region + selection + app),
//              shown as capsule pills under the box. The offline premade row
//              arrives on `chips:fallback` (it does NOT clear `pending`, so the
//              accent underline keeps sweeping until the real round lands).
// `pending`  — true while main has a chips generation round in flight (drives
//              the accent underline sweep under the box).
// `nextChips`— post-response "next action" chips, shown as a horizontal
//              scrollable row at the end of the box once an answer lands.
//
// Everything except the next-action row is cleared on AI-mode end; the
// next-action row survives so re-opening the box within the session window
// restores the follow-up chips. A submit or explicit reset clears it.
export function useChips() {
  const [chips, setChips] = useState<SuggestionChip[]>([]);
  const [nextChips, setNextChips] = useState<SuggestionChip[]>([]);
  const [pending, setPending] = useState(false);

  // Which kind of chips are on screen right now and when they appeared, so a
  // late AI result is held back until the premade row has had its minimum
  // display time (the swap timer fires then, replacing them silently).
  const chipSource = useRef<'fallback' | 'ai'>('ai');
  const chipShownAt = useRef(0);
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSwapTimer = useCallback(() => {
    if (swapTimer.current !== null) {
      clearTimeout(swapTimer.current);
      swapTimer.current = null;
    }
  }, []);

  const applyResult = useCallback((next: SuggestionChip[]) => {
    chipSource.current = 'ai';
    chipShownAt.current = Date.now();
    setChips(next);
    // The underline keeps sweeping until the AI chips are actually shown —
    // clearing it here (when they land) is what makes the loader feel tied to
    // the real response, not to the round finishing early.
    setPending(false);
  }, []);

  useEffect(() => {
    // Offline premade chips: applied immediately, but never touch `pending` —
    // the underline sweep keeps going until the real AI round lands. An EMPTY
    // fallback is the "tab/app switched" clear signal: drop stale chips now and
    // mark nothing premade, so a fast cache-hit result applies right away
    // instead of being held for the minimum display time.
    const offFallback = ipc.onChipsFallback((fallback) => {
      clearSwapTimer();
      if (fallback.length === 0) {
        chipSource.current = 'ai';
        setChips([]);
        return;
      }
      chipSource.current = 'fallback';
      chipShownAt.current = Date.now();
      setChips(fallback);
    });
    const offResult = ipc.onChipsResult((result) => {
      // Nothing to show → clear stale chips right away (empty context or a
      // cancelled round); no reason to keep the premade row hanging around.
      if (result.length === 0) {
        applyResult(result);
        return;
      }
      const shownMs = Date.now() - chipShownAt.current;
      if (chipSource.current === 'fallback' && shownMs < MIN_CHIP_DISPLAY_MS) {
        // Keep the premade chips for their minimum display time, then swap.
        // `pending` is NOT cleared here: the underline keeps sweeping until the
        // AI chips actually replace the premade row (see applyResult).
        const wait = MIN_CHIP_DISPLAY_MS - shownMs;
        clearSwapTimer();
        swapTimer.current = setTimeout(() => {
          swapTimer.current = null;
          applyResult(result);
        }, wait);
      } else {
        applyResult(result);
      }
    });
    const offPending = ipc.onChipsPending((p) => setPending(p));
    const offNext = ipc.onNextChipsResult((result) => setNextChips(result));
    const offStart = ipc.onAIModeStart(() => setPending(true));
    const offEnd = ipc.onAIModeEnd(() => {
      setPending(false);
      clearSwapTimer();
      chipSource.current = 'ai';
      setChips([]);
    });
    return () => {
      offFallback();
      offResult();
      offPending();
      offNext();
      offStart();
      offEnd();
    };
  }, [applyResult, clearSwapTimer]);

  const clear = useCallback(() => {
    setPending(false);
    clearSwapTimer();
    chipSource.current = 'ai';
    setChips([]);
    setNextChips([]);
  }, [clearSwapTimer]);

  const restoreNext = useCallback((chips: SuggestionChip[]) => {
    setNextChips(chips);
  }, []);

  return { chips, nextChips, pending, clear, restoreNext };
}
