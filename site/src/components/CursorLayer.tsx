import { useEffect, useId, useRef, useState } from 'react';
import {
  CURSOR_SHAPES,
  VIEWBOX,
  type CursorGlyph,
  type CursorShapeId,
} from '../lib/cursorShapes';

const SIZE = 26;
const FROST = '#eeede8';
const WARM_BLACK = '#3a3630';
const INK_BLUE = 'rgba(64, 112, 216, 0.72)';
const INK_WHITE_BLUE = 'rgba(203, 222, 255, 0.95)';

const TEXT_SELECTOR =
  'textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"], [contenteditable=""], [data-cursor="text"]';

const CLICK_SELECTOR =
  'a[href], button, select, summary, [role="button"], [role="link"], [role="menuitem"], label, input[type="checkbox"], input[type="radio"], [data-cursor="link"]';

function lightUiActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
}

function mapElementToShape(el: Element | null): CursorShapeId | null {
  if (!el) return null;
  const explicit = el.closest('[data-cursor]')?.getAttribute('data-cursor');
  if (explicit && CURSOR_SHAPES[explicit as CursorShapeId]) return explicit as CursorShapeId;
  if (el.closest(TEXT_SELECTOR)) return 'text';
  if (el.closest(CLICK_SELECTOR)) return 'link';
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
      return <path d="M8 12.5 L20 12.5 M14 5 L14 20" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />;
    case 'minus':
      return <path d="M8 12.5 L20 12.5" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />;
    case 'ring':
      return (
        <circle
          className="scur__ring"
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

function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: fine)');
    setFine(mq.matches);
    const on = () => setFine(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return fine;
}

export default function CursorLayer({ initial }: { initial?: { x: number; y: number } }) {
  const fine = useFinePointer();
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [shapeId, setShapeId] = useState<CursorShapeId>('pointer');
  const posRef = useRef(initial ?? { x: -100, y: -100 });
  const initialRef = useRef(initial);
  const [visible, setVisible] = useState(Boolean(initial));
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  useEffect(() => {
    if (!fine) return;
    const root = rootRef.current;
    if (!root) return;

    document.documentElement.classList.add('spirit-cursor-on');

    let current: CursorShapeId = 'pointer';
    let on = false;

    const apply = () => {
      if (fieldRef.current) {
        fieldRef.current.style.transform = translate(posRef.current.x, posRef.current.y, current);
      }
    };

    const show = () => {
      if (!on) {
        on = true;
        setVisible(true);
        root.classList.add('is-on');
      }
    };

    if (initialRef.current) {
      posRef.current = initialRef.current;
      apply();
      show();
    }

    const onMove = (e: PointerEvent) => {
      posRef.current.x = e.clientX;
      posRef.current.y = e.clientY;
      const next = mapElementToShape(document.elementFromPoint(e.clientX, e.clientY)) ?? 'pointer';
      if (next !== current) {
        current = next;
        setShapeId(next);
      }
      apply();
      show();
    };

    const onLeave = () => {
      on = false;
      root.classList.remove('is-on');
      setVisible(false);
    };

    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);

    return () => {
      window.removeEventListener('pointermove', onMove, true);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.documentElement.classList.remove('spirit-cursor-on');
    };
  }, [fine]);

  useEffect(() => {
    if (fieldRef.current) {
      fieldRef.current.style.transform = translate(posRef.current.x, posRef.current.y, shapeId);
    }
  }, [shapeId]);

  if (!fine) return null;

  const s = CURSOR_SHAPES[shapeId];
  const light = lightUiActive();
  const body = light ? FROST : WARM_BLACK;
  const ink = light ? INK_BLUE : INK_WHITE_BLUE;
  const shadow = light
    ? 'drop-shadow(0 1px 2px rgba(0,0,0,0.16))'
    : 'drop-shadow(0 2px 3px rgba(0,0,0,0.45))';

  return (
    <div ref={rootRef} className={`scur${visible ? ' is-on' : ''}`} aria-hidden="true">
      <div ref={fieldRef} style={{ willChange: 'transform' }}>
        <svg
          className="scur__svg"
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
          style={{ filter: shadow }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" style={{ stopColor: 'color-mix(in srgb, var(--sbox-accent) 45%, #fff)' }} />
              <stop offset="40%" style={{ stopColor: 'color-mix(in srgb, var(--sbox-accent) 72%, #fff)' }} />
              <stop offset="100%" style={{ stopColor: 'var(--sbox-accent)' }} />
            </linearGradient>
            <clipPath id={clipId}>
              <path d={s.path} />
            </clipPath>
          </defs>
          <path d={s.path} fill="none" stroke={`url(#${gradId})`} strokeWidth={3} strokeLinejoin="round" />
          <path d={s.path} fill={body} stroke="none" strokeLinejoin="round" />
          <g clipPath={`url(#${clipId})`} className="scur__sheen-tilt" style={{ mixBlendMode: 'screen' }}>
            <rect className="scur__sheen" x={-24} y={0} width={24} height={VIEWBOX} fill="rgba(255,255,255,0.22)" />
            <rect className="scur__sheen" x={-15} y={0} width={6} height={VIEWBOX} fill="rgba(255,255,255,0.55)" />
          </g>
          {s.glyph && <Glyph glyph={s.glyph} ink={ink} />}
        </svg>
      </div>
    </div>
  );
}