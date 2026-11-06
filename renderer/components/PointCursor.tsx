import { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
} from 'framer-motion';
import { CursorHalo } from './CursorHalo';
import { BibataCursor } from './BibataCursor';
import type { ScreenAnnotation } from '../../electron/types';
import { annotationChipTheme } from '../lib/annotationTheme';

// Annotation protocol (Phase 7): plays back a stream of [POINT]/[BOX]/[ARROW]
// targets as a touring branded cursor. Main broadcasts newly-completed tags per
// token delta in story order; this component springs the cursor to each
// anchor — the exact pixel for a point, the region center for a box, the arrow
// head for an arrow — leaves it dwelling while the ring settles, then fades.
// It never touches the physical mouse. The persistent boxes/arrows/chips live
// in ScreenAnnotations; this component is only the fly-to narrator.
//
// Streams arrive slowly (one tag per sentence), so the tour runs on a length
// of a timer: consume the queue at a fixed dwell pace, and when main keeps
// appending tags mid-fade, simply resume the tour instead of vanishing.

const PER_POINT_DWELL_MS = 1150;
const START_DELAY_MS = 220;
const TAIL_FADE_MS = 420;

// `[annotate]` decode aid: tour events (enqueue / fly / land / fade) print to
// the renderer DevTools console. Every fly-to logs the anchor it was asked to
// hit; if the cursor "didn't point nicely", compare this against the main
// process `[annotate] ... img -> screen` lines to see whether the mismatch is
// the MODEL's target or the MAPPING.
function logTour(event: string, detail?: string): void {
  console.debug(`[annotate] ${event}${detail ? ` ${detail}` : ''}`);
}

// Where the cursor lands for each annotation kind — in the overlay's own space.
export function annotationAnchor(a: ScreenAnnotation): { x: number; y: number; label: string } {
  switch (a.kind) {
    case 'point':
      return { x: a.x, y: a.y, label: a.label };
    case 'box':
      return { x: a.x + a.w / 2, y: a.y + a.h / 2, label: a.label };
    case 'arrow':
      return { x: a.x2, y: a.y2, label: a.label };
  }
}

type Props = {
  // The FULL annotation set for this run (accumulated). The component tours
  // only items whose seq it hasn't visited yet, so re-renders with the same
  // items are no-ops and a clear ([]) ends the tour.
  annotations: ScreenAnnotation[];
  // Replay trigger: when the parent bumps this counter (the overlay's ↻
  // button), the cursor re-flies the WHOLE current set from seq 1 — a full
  // re-tour of every chip the answer produced.
  replaySignal?: number;
};

export function PointCursor({ annotations, replaySignal = 0 }: Props) {
  // Tour state lives in refs so bursts of IPC events never re-render per
  // event; UI state flips only when a target actually changes.
  const queueRef = useRef<{ x: number; y: number; label: string }[]>([]);
  const cursorIndexRef = useRef(0);
  const lastTourSeqRef = useRef(0);
  const activeRef = useRef(false);
  const cancelRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [active, setActive] = useState(false);
  // Keep `current` holding the anchor so the label chip/ring row below stays
  // generic; the type only narrows at enqueue time in annotationAnchor.
  const [current, setCurrent] = useState<{ x: number; y: number; label: string } | null>(null);
  // Spring-position mirror fed into CursorHalo so the comet trail follows the
  // FLIGHT (not just the landing pixel). Only updates while the cursor moves.
  const [trail, setTrail] = useState<{ x: number; y: number } | null>(null);

  // Spring-driven flight position. Tuned to be crisp like the reference
  // pointer: slightly OVERdamped (no overshoot/wobble on arrival), faster than
  // the old soft spring (~a third-second settle instead of a full second of
  // swish), so the landing ring reads as "here". Do NOT lower damping below
  // critical — underdamped wobble is what made the pointer look sloppy.
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 130, damping: 22, mass: 0.7 });
  const sy = useSpring(y, { stiffness: 130, damping: 22, mass: 0.7 });

  useMotionValueEvent(sx, 'change', (v) => {
    if (!activeRef.current || cancelRef.current) return;
    setTrail({ x: v, y: sy.get() });
  });
  useMotionValueEvent(sy, 'change', (v) => {
    if (!activeRef.current || cancelRef.current) return;
    setTrail({ x: sx.get(), y: v });
  });

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const step = () => {
    const idx = cursorIndexRef.current;
    const q = queueRef.current;
    if (idx >= q.length) {
      // Idle: wait one framing beat for stragglers (the stream can still be
      // mid-sentence), then either keep touring if new items arrived or fade.
      clearTimer();
      timerRef.current = setTimeout(() => {
        if (cursorIndexRef.current < queueRef.current.length) {
          step();
        } else {
          closeTour();
        }
      }, TAIL_FADE_MS);
      return;
    }
    const t = q[idx];
    cursorIndexRef.current = idx + 1;
    setCurrent(t);
    logTour(`fly ${idx + 1}/${q.length}`, `-> (${Math.round(t.x)},${Math.round(t.y)}) "${t.label}"`);
    x.set(t.x);
    y.set(t.y);
    timerRef.current = setTimeout(step, PER_POINT_DWELL_MS);
  };

  const openTour = () => {
    activeRef.current = true;
    cancelRef.current = false;
    setActive(true);
    logTour('start', `queued=${queueRef.current.length} targets`);
    timerRef.current = setTimeout(step, START_DELAY_MS);
  };

  const closeTour = () => {
    activeRef.current = false;
    cancelRef.current = true;
    clearTimer();
    setActive(false);
    setCurrent(null);
    setTrail(null);
    queueRef.current = [];
    cursorIndexRef.current = 0;
    logTour('fade', 'tour ended');
  };

  useEffect(() => {
    if (annotations.length === 0) {
      // Authoritative clear (answer done / errored / new submit).
      lastTourSeqRef.current = 0;
      closeTour();
      return;
    }
    const fresh = annotations.filter((a) => a.seq > lastTourSeqRef.current);
    if (fresh.length === 0) return;
    lastTourSeqRef.current = Math.max(...fresh.map((a) => a.seq));
    queueRef.current = queueRef.current.concat(fresh.map(annotationAnchor));
    if (!activeRef.current) {
      openTour();
    } else if (!timerRef.current) {
      // The tour went idle (finished, scheduled to fade) but the stream kept
      // coming — resume instead of letting it vanish.
      timerRef.current = setTimeout(step, START_DELAY_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations]);

  useEffect(
    () => () => {
      cancelRef.current = true;
      clearTimer();
    },
    [],
  );

  // Replay: a bump from the parent re-tours the CURRENT set in full. Aborts
  // whatever tour is running and restarts from the first annotation so chips
  // are already numbered — the pointer re-flies them in story order exactly as
  // the answer delivered them.
  useEffect(() => {
    if (replaySignal <= 0 || annotations.length === 0) return;
    closeTour();
    cancelRef.current = false;
    const ordered = [...annotations].sort((a, b) => a.seq - b.seq);
    queueRef.current = ordered.map(annotationAnchor);
    lastTourSeqRef.current = ordered[ordered.length - 1]?.seq ?? 0;
    logTour('replay', `re-flying ${ordered.length} target(s)`);
    openTour();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaySignal]);

  return (
    <AnimatePresence>
      {active && current && (
        <motion.div
          className="pointer-events-none fixed left-0 top-0 z-[9998]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* The guest cursor flying to the target. */}
          <motion.div className="absolute" style={{ x: sx, y: sy }} aria-hidden>
            <BibataCursor />
          </motion.div>
          {/* Comet trail behind the flight (reuses the halo look). */}
          {trail && <CursorHalo x={trail.x} y={trail.y} />}
          {/* The settled ring — pulses at the landing pixel so the exact
              element stays findable after the cursor has moved on. */}
          <motion.div
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
            style={{
              left: current.x,
              top: current.y,
              borderColor: 'var(--spirit-accent)',
              boxShadow: '0 0 0 4px color-mix(in srgb, var(--spirit-accent) 18%, transparent)',
            }}
            initial={{ width: 14, height: 14, opacity: 0.9 }}
            animate={{ width: 30, height: 30, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.85, ease: 'easeOut' }}
          />
          {/* Label chip under the ring. */}
          {current.label && (
            <motion.div
              className="absolute -translate-x-1/2 rounded-full px-2.5 py-1 text-[11px] font-medium shadow-glass backdrop-blur-md"
              style={{
                left: current.x,
                top: current.y + 22,
                ...annotationChipTheme(),
                whiteSpace: 'nowrap',
              }}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 2 }}
              transition={{ duration: 0.15 }}
            >
              {current.label}
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}