import { useId } from 'react';
import { CURSOR_SHAPES, VIEWBOX } from './cursorShapes';

// Size of the flying POINT cursor (slightly larger than the real cursor's
// 26px so the audience arrow reads at a glance as a "guest" pointer).
const SIZE = 30;

// A standalone render of the branded Bibata arrow (accent-gradient border,
// frosted/warm-black body) WITHOUT the real cursor's DOM-pointer tracking or
// shape probing. Used by the POINT protocol's travelling cursor — the same
// glass look as SpiritCursor, flying independently of the physical mouse. The
// `pointer` shape carries no glyph, so no Glyph art is needed here.
export function BibataCursor() {
  // Use the `pointer` silhouette only — the cursor always POINTs.
  const shape = CURSOR_SHAPES.pointer;
  const dark = typeof document !== 'undefined' && !document.documentElement.classList.contains('dark');
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const scale = SIZE / VIEWBOX;
  const hx = shape.hotspot[0] * scale;
  const hy = shape.hotspot[1] * scale;
  const FROST = 'rgba(238, 237, 232, 0.94)';
  const WARM_BLACK = 'rgba(58, 54, 48, 0.95)';

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      style={{
        overflow: 'visible',
        filter: dark
          ? 'drop-shadow(0 2px 3px rgba(0,0,0,0.4))'
          : 'drop-shadow(0 1px 2px rgba(0,0,0,0.16))',
        marginLeft: -hx,
        marginTop: -hy,
      }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: 'color-mix(in srgb, var(--spirit-accent) 45%, #fff)' }} />
          <stop offset="40%" style={{ stopColor: 'color-mix(in srgb, var(--spirit-accent) 72%, #fff)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--spirit-accent)' }} />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={shape.path} />
        </clipPath>
      </defs>
      <path d={shape.path} fill="none" stroke={`url(#${gradId})`} strokeWidth={3} strokeLinejoin="round" />
      <path d={shape.path} fill={dark ? WARM_BLACK : FROST} stroke="none" strokeLinejoin="round" />
    </svg>
  );
}