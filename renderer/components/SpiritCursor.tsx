import { useEffect, useId, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CURSOR_SHAPES, VIEWBOX, type CursorGlyph, type CursorShapeId } from './cursorShapes';

// Display size of every Bibata shape (the 32-unit viewBox is scaled to this).
const SIZE = 26;
// Light-theme body: warm frosted white that reads as soft "glass" on the
// light pill. Dark-glass mode swaps to a warm black body (the accent-gradient
// border keeps the silhouette defined on the dark glass).
const FROST = 'rgba(238, 237, 232, 0.94)';
const WARM_BLACK = 'rgba(58, 54, 48, 0.95)';
// Glyph tints: a bluish blue on the frosted-white body, a whitish-blue on the
// warm-black body — keeps the "no" slash / icons legible while echoing the
// cursor's blue-ish accent gradient border. The light-theme tint is kept
// low-key (not near-black) so it reads as a subtle accent, not a harsh blob.
const INK_BLUE = 'rgba(64, 112, 216, 0.72)';
const INK_WHITE_BLUE = 'rgba(203, 222, 255, 0.95)';

// html.dark = LIGHT UI in this app (see header note in MermaidDiagram / App).
// Returns true for the default dark-glass pill.
function darkUiActive(): boolean {
  return typeof document === 'undefined' || !document.documentElement.classList.contains('dark');
}

type Props = {
  x: number;
  y: number;
  // Standard OS cursor id under the pointer (from CursorPosition.shape), e.g.
  // 'text' over an input, 'link' over a link, 'horz' over a resizer. Unknown
  // or missing values fall back to the default arrow. Over Spirit's own UI
  // (the prompt box, Settings, …) this probe value is meaningless — the probe
  // deliberately measures the app BENEATH the overlay — so the DOM element
  // under the pointer supplies the shape instead (see mapElementToShape).
  shape?: string;
  // When the probe reports the pointer is over a classic non-client
  // scrollbar, which orientation it is ('vert' / 'horz', null otherwise).
  // Over EITHER a scrollbar the custom cursor is suppressed entirely — the
  // bar already paints its own arrows, and the custom arrow/ring just fights
  // them. Only applied to probed (external app) shapes; Spirit's own UI
  // always draws its DOM-derived shape.
  scrollbar?: 'vert' | 'horz' | null;
  // When set, this shape wins over BOTH the DOM-derived shape and the probed
  // shape. Used during an active paint-to-select drag so the crosshair holds
  // even if the pointer sweeps across the prompt box mid-drag.
  forceShape?: CursorShapeId;
};

// Elements that should draw the I-beam / text-entry shape.
const TEXT_SELECTOR =
  'textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"], [contenteditable=""], [data-cursor="text"]';

// Elements that should draw the hand / link shape. Checked AFTER the text
// targets so a <textarea> wrapped in a <label> still reads as text.
const CLICK_SELECTOR =
  'a[href], button, select, summary, [role="button"], [role="link"], [role="menuitem"], label, input[type="checkbox"], input[type="radio"], [data-cursor="link"]';

// Derive the Bibata shape from the element under the physical pointer while it
// hovers Spirit's own UI (elements inside a `data-spirit-ui` root). Returns
// null when the pointer is over the app beneath (no Spirit UI there) — the
// caller then falls back to the probed shape of that app.
function mapElementToShape(el: Element | null): CursorShapeId | null {
  if (!el || !el.closest('[data-spirit-ui]')) return null;
  const explicit = el.closest('[data-cursor]')?.getAttribute('data-cursor');
  if (explicit && CURSOR_SHAPES[explicit as CursorShapeId]) return explicit as CursorShapeId;
  if (el.closest(TEXT_SELECTOR)) return 'text';
  if (el.closest(CLICK_SELECTOR)) return 'link';
  // Fallback: mirror the element's own CSS cursor (the box's drag handle uses
  // cursor-grab, labels cursor-pointer, …). The OS cursor is forced to `none`
  // over Spirit UI, so read what the stylesheet intended and draw the
  // equivalent Bibata shape — the grab handle gets the pointing hand on hover
  // (cursor-grab), the clenched hand once the user presses and drags
  // (cursor-grabbing / active:), etc.
  switch (getComputedStyle(el).cursor) {
    case 'grab':
      return 'link';
    case 'grabbing':
      return 'grabbing';
    case 'pointer':
    case 'alias':
    case 'copy':
    case 'cell':
      return 'link';
    case 'text':
    case 'vertical-text':
      return 'text';
    case 'move':
    case 'all-scroll':
      return 'move';
    case 'not-allowed':
    case 'no-drop':
      return 'unavailable';
    case 'wait':
    case 'progress':
      return 'busy';
    case 'help':
      return 'help';
    case 'crosshair':
      return 'cross';
    case 'n-resize':
    case 's-resize':
      return 'vert';
    case 'e-resize':
    case 'w-resize':
      return 'horz';
    case 'ne-resize':
    case 'sw-resize':
      return 'dgn1';
    case 'nw-resize':
    case 'se-resize':
      return 'dgn2';
    default:
      return 'pointer';
  }
}

function translate(cx: number, cy: number, shape: CursorShapeId): string {
  const s = CURSOR_SHAPES[shape] ?? CURSOR_SHAPES.pointer;
  const scale = SIZE / VIEWBOX;
  return `translate3d(${cx - s.hotspot[0] * scale}px, ${cy - s.hotspot[1] * scale}px, 0)`;
}

function Glyph({ glyph, ink }: { glyph: CursorGlyph; ink: string }) {
  switch (glyph) {
    case 'slash':
      // The "no" slash across the arrow, drawn contrasting so it reads on the
      // body (Bibata draws it as a color difference, not a hole).
      return <path d="M27 2.5 L6 28.5" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />;
    case 'question':
      return (
        <g>
          <path
            d="M21.5 8.5 C21.5 5.5 24.5 4.2 26.6 5.8 C28.6 7.3 28 10.2 26.2 11.6 C24.6 12.9 22.8 13.4 22.8 15.2"
            fill="none"
            stroke={ink}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx="22.8" cy="18.8" r="1.4" fill={ink} />
        </g>
      );
    case 'plus':
      return (
        <path d="M8 12.5 L20 12.5 M14 5 L14 20" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />
      );
    case 'minus':
      return <path d="M8 12.5 L20 12.5" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />;
    case 'ring':
      // The "busy" ring spins (like the real IDC_APPSTARTING cursor), drawn
      // as a dashed arc so the rotation reads as motion. Sits high in the
      // shape, tucked just under the arrowhead.
      return (
        <circle
          className="spirit-cursor-busy-ring"
          cx={25.5}
          cy={4.5}
          r={4}
          fill="none"
          stroke={ink}
          strokeWidth={1.8}
          strokeDasharray="13 9"
          strokeLinecap="round"
        />
      );
  }
}

// The accent-colored cursor that replaces the OS cursor while AI mode is
// active (capture mode) or while Settings is open — i.e. whenever the overlay
// owns the mouse. It mirrors the Bibata cursor set: whichever standard Windows
// cursor sits under the physical pointer (text, link, resize, ...) is drawn
// here. Over Spirit's own UI (the prompt box, Settings) the shape comes from
// the DOM element under the pointer (I-beam over the prompt / form inputs,
// hand over buttons and links, arrow elsewhere) so the OS cursor never shows.
// Every shape has a theme-aware body — warm black on the dark-glass pill,
// warm frosted white on the light pill — with an accent-gradient border and a
// soft two-layer sheen slowly sweeps across it (clipped to the silhouette) so
// the cursor glows with the same gradient motion as the idle loader dot.
//
// Positioned via a plain inner div whose transform is written directly from
// native pointermove events — no React state per move, so the arrow tracks the
// mouse at input rate with zero spring lag (unlike the halo, which
// intentionally lags behind).
export function SpiritCursor({ x, y, shape, scrollbar, forceShape }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Shape derived from the DOM element under the pointer while hovering
  // Spirit's own UI (box, Settings). null = not over Spirit UI → use `shape`.
  const [domShape, setDomShape] = useState<CursorShapeId | null>(null);
  const domShapeRef = useRef<CursorShapeId | null>(null);
  domShapeRef.current = domShape;
  const propShape: CursorShapeId = CURSOR_SHAPES[shape as CursorShapeId] ? (shape as CursorShapeId) : 'pointer';
  const shapeRef = useRef<CursorShapeId>('pointer');
  shapeRef.current = propShape;
  // Mirror forceShape so the native pointermove transform (which bypasses
  // React state) still applies the forced shape's hotspot.
  const forceShapeRef = useRef<CursorShapeId | null>(null);
  forceShapeRef.current = forceShape ?? null;
  const shapeId: CursorShapeId = forceShape ?? domShape ?? propShape;
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const sweepBandId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const sweepCoreId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const s = CURSOR_SHAPES[shapeId];
  const dark = darkUiActive();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (cx: number, cy: number) => {
      const shape = forceShapeRef.current ?? domShapeRef.current ?? shapeRef.current;
      el.style.transform = translate(cx, cy, shape);
    };
    set(x, y);
    const onMove = (e: MouseEvent) => {
      // Resolve the DOM-driven shape FIRST so the transform below already
      // uses the fresh hotspot when the shape just changed.
      const next = mapElementToShape(document.elementFromPoint(e.clientX, e.clientY));
      if (next !== domShapeRef.current) {
        domShapeRef.current = next;
        setDomShape(next);
      }
      set(e.clientX, e.clientY);
    };
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('mousemove', onMove, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('mousemove', onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the polled position too, so the arrow keeps up even when native
  // pointer events stop arriving (e.g. a momentary click-through override
  // during click forwarding). Only the transform is touched here. The hotspot
  // moves when the shape changes, so the transform is re-applied on every
  // shape switch too.
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.transform = translate(x, y, shapeId);
    }
  }, [x, y, shapeId]);

  // Over a non-client scrollbar of either orientation (probed, external app)
  // the custom cursor hides so the bar's own arrows aren't shadowed. Spirit's
  // own UI always draws its DOM-derived shape, and an active paint drag keeps
  // the forced crosshair.
  if ((scrollbar === 'vert' || scrollbar === 'horz') && domShape === null && !forceShape) {
    return null;
  }

  return (
    <motion.div
      className="pointer-events-none fixed left-0 top-0 z-[10001]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
    >
      <div ref={ref} style={{ willChange: 'transform' }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
          // Theme-aware shadow: the strong black drop-shadow only works on the
          // dark glass (it vanishes there). On light surfaces a black shadow
          // behind the frosted arrow reads as a harsh dark blob, so it's
          // softened to a faint lift.
          style={{
            filter: dark
              ? 'drop-shadow(0 2px 3px rgba(0,0,0,0.45))'
              : 'drop-shadow(0 1px 2px rgba(0,0,0,0.16))',
          }}
        >
          <defs>
            {/* Static accent gradient in light shades: pale top-left → soft →
                base accent, so the shape reads as luminous pastel glass. */}
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" style={{ stopColor: 'color-mix(in srgb, var(--spirit-accent) 45%, #fff)' }} />
              <stop offset="40%" style={{ stopColor: 'color-mix(in srgb, var(--spirit-accent) 72%, #fff)' }} />
              <stop offset="100%" style={{ stopColor: 'var(--spirit-accent)' }} />
            </linearGradient>
            {/* Broad soft glow band + narrow bright core that sweep across the
                shape together as a passing specular sheen. */}
            <linearGradient id={sweepBandId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(255,255,255,0)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0.2)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
            <linearGradient id={sweepCoreId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(255,255,255,0)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0.65)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
            <clipPath id={clipId}>
              <path d={s.path} />
            </clipPath>
          </defs>

          <path d={s.path} fill="none" stroke={`url(#${gradId})`} strokeWidth={3} strokeLinejoin="round" />
          <path d={s.path} fill={dark ? WARM_BLACK : FROST} stroke="none" strokeLinejoin="round" />

          {/* The moving sheen, clipped to the silhouette. A broad faint glow
              with a brighter core passes across, slightly tilted, blended
              `screen` so it brightens the gradient underneath. */}
          <g clipPath={`url(#${clipId})`}>
            <g className="spirit-cursor-sweep-tilt" style={{ mixBlendMode: 'screen' }}>
              <rect
                className="spirit-cursor-sweep"
                x={-24}
                y={0}
                width={24}
                height={VIEWBOX}
                fill={`url(#${sweepBandId})`}
              />
              <rect
                className="spirit-cursor-sweep"
                x={-15}
                y={0}
                width={6}
                height={VIEWBOX}
                fill={`url(#${sweepCoreId})`}
              />
            </g>
          </g>

          {s.glyph && <Glyph glyph={s.glyph} ink={dark ? INK_WHITE_BLUE : INK_BLUE} />}
        </svg>
      </div>
    </motion.div>
  );
}
