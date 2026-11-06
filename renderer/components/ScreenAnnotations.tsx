import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import type { ScreenAnnotation } from '../../electron/types';
import { annotationChipTheme, type AnnotationChipTheme } from '../lib/annotationTheme';

// Annotation protocol overlay (Phase 7): draws the answer's [POINT]/[BOX]/
// [ARROW] tags as a persistent annotation layer — accent-stroked boxes,
// arrows with arrowheads, and numbered chips ("1 · Save button") that let the
// answer say "now the third one". Coordinates arrive display-LOCAL (main
// already translated absolute screen DIP by the overlay window's origin), so
// every element lands exactly where it belongs on any monitor.
//
// Persistence is a USER CHOICE: annotations STAY up while the user reads the
// finished answer, then auto-fade ~8s after the last content arrives (the
// answer's authoritative re-broadcast). They also disappear on (a) a new
// submit/final/error clear (payload []), or (b) the user dismissing the layer
// with the small ✕ — the only pointer-interactive spot on an otherwise fully
// click-through overlay.

const CHIP_TEXT = '11px';
const ACCENT = 'var(--spirit-accent)';
const BOX_FILL = 'color-mix(in srgb, var(--spirit-accent) 12%, transparent)';
const BOX_GLOW = 'color-mix(in srgb, var(--spirit-accent) 22%, transparent)';
const ANNOT_AUTO_FADE_MS = 20000;
const ANNOT_FADE_OUT_MS = 500;

type Props = {
  // The full annotation set for the current run (story order, seq ascending).
  annotations: ScreenAnnotation[];
};

export function ScreenAnnotations({ annotations }: Props) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const fadeTimerRef = useRef<number | null>(null);
  // Chip palette resolves against the CURRENT theme (light UI = html.dark);
  // re-computed per render so an accent/theme switch mid-session reapplies.
  const theme = annotationChipTheme();

  const cancelFade = () => {
    if (fadeTimerRef.current) {
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    setFading(false);
  };

  // A run with content shows the layer (re-showing it even after a manual
  // dismiss once NEW annotations arrive); an empty payload hides it. Every
  // content arrival restarts the idle clock, so the 20s auto-fade measures
  // from the LAST broadcast — the authoritative final set — leaving the boxes/
  // arrows on screen while the user reads the finished answer.
  useEffect(() => {
    if (annotations.length === 0) {
      cancelFade();
      setVisible(false);
      return;
    }
    setVisible(true);
    setFading(false);
    if (fadeTimerRef.current) window.clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = window.setTimeout(() => {
      fadeTimerRef.current = null;
      setFading(true);
      window.setTimeout(() => setVisible(false), ANNOT_FADE_OUT_MS);
    }, ANNOT_AUTO_FADE_MS);
    return () => {
      if (fadeTimerRef.current) window.clearTimeout(fadeTimerRef.current);
    };
  }, [annotations]);

  if (!visible || annotations.length === 0) return null;

  const arrows = annotations.filter((a) => a.kind === 'arrow') as Extract<
    ScreenAnnotation,
    { kind: 'arrow' }
  >[];

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[9997] overflow-hidden"
      style={{ opacity: fading ? 0 : 1, transition: `opacity ${ANNOT_FADE_OUT_MS}ms ease-in` }}
    >
      {/* All arrow lines/heads in one SVG pass so overlaps render cleanly. */}
      {arrows.length > 0 && (
        <svg className="absolute inset-0 h-full w-full" aria-hidden>
          {arrows.map((a) => (
            <ArrowLine key={`arrow-${a.seq}`} a={a} />
          ))}
        </svg>
      )}

      {annotations.map((a) => {
        if (a.kind === 'arrow') {
          const cx = (a.x1 + a.x2) / 2;
          const cy = (a.y1 + a.y2) / 2;
          const nearBottom = cy > window.innerHeight - 46;
          return (
            <Chip
              key={`arrow-chip-${a.seq}`}
              label={`${a.seq}${a.label ? ` · ${a.label}` : ''}`}
              x={cx + 10}
              y={cy}
              direction={nearBottom ? 'up' : 'down'}
              theme={theme}
            />
          );
        }
        if (a.kind === 'point') {
          const nearBottom = a.y > window.innerHeight - 46;
          return (
            <motion.div
              key={`point-${a.seq}`}
              className="absolute"
              style={{ left: a.x, top: a.y } as CSSProperties}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.18 }}
            >
              <div
                className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                style={{ borderColor: ACCENT, boxShadow: `0 0 0 5px ${BOX_GLOW}` }}
              />
              <Chip
                label={`${a.seq} · ${a.label}`}
                x={a.x}
                y={a.y + 18}
                direction={nearBottom ? 'up' : 'down'}
                theme={theme}
              />
            </motion.div>
          );
        }
        if (a.kind === 'box') {
          const topInside = a.y >= 26;
          return (
            <motion.div
              key={`box-${a.seq}`}
              className="absolute"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18 }}
            >
              <div
                className="absolute rounded-xl border-2"
                style={{
                  left: a.x,
                  top: a.y,
                  width: a.w,
                  height: a.h,
                  borderColor: ACCENT,
                  background: BOX_FILL,
                  boxShadow: `0 0 0 1px ${BOX_GLOW}, inset 0 0 0 1px ${BOX_GLOW}`,
                } as CSSProperties}
              />
              <Chip
                label={`${a.seq} · ${a.label}`}
                x={a.x + 12}
                y={topInside ? a.y + 8 : a.y + a.h + 10}
                direction={topInside ? 'down' : 'up'}
                anchorLeft
                theme={theme}
              />
            </motion.div>
          );
        }
        return null;
      })}

      {/* No manual dismiss: the layer auto-fades after 20s or is cleared by
          the next submit/final/error broadcast. Fully click-through. */}
    </div>
  );
}

// A single arrow's line + arrowhead. The label chip renders OUTSIDE the svg
// (in the main pass) because HTML can't nest inside SVG.
function ArrowLine({ a }: { a: Extract<ScreenAnnotation, { kind: 'arrow' }> }) {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const HEAD = 11;
  const WING = 5;
  const headPts = [
    `${a.x2},${a.y2}`,
    `${a.x2 - ux * HEAD - uy * WING},${a.y2 - uy * HEAD + ux * WING}`,
    `${a.x2 - ux * HEAD + uy * WING},${a.y2 - uy * HEAD - ux * WING}`,
  ].join(' ');
  return (
    <g>
      <line
        x1={a.x1}
        y1={a.y1}
        x2={a.x2}
        y2={a.y2}
        stroke={ACCENT}
        strokeWidth={2}
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 3px ${BOX_GLOW})` }}
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={headPts} fill={ACCENT} />
    </g>
  );
}

function Chip({
  label,
  x,
  y,
  direction,
  anchorLeft,
  theme,
}: {
  label: string;
  x: number;
  y: number;
  direction: 'up' | 'down';
  anchorLeft?: boolean;
  theme: AnnotationChipTheme;
}) {
  const style: CSSProperties = { left: x, top: y };
  style.transform =
    direction === 'up'
      ? anchorLeft
        ? 'translateY(-100%)'
        : 'translate(-50%, -100%)'
      : anchorLeft
        ? undefined
        : 'translateX(-50%)';
  return (
    <motion.div
      className="absolute whitespace-nowrap rounded-full px-2.5 py-1 font-medium shadow-glass backdrop-blur-md"
      style={{
        fontSize: CHIP_TEXT,
        ...theme,
        ...style,
      }}
      initial={{ opacity: 0, y: direction === 'up' ? -4 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {label}
    </motion.div>
  );
}