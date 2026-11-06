import { useId } from 'react';
import { CURSOR_SHAPES, VIEWBOX } from '../../lib/cursorShapes';

export default function BibataCursor({ className = '' }: { className?: string }) {
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const shape = CURSOR_SHAPES.pointer;

  return (
    <span className={`sbibata ${className}`.trim()} aria-hidden="true">
      <svg viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} focusable="false">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: 'color-mix(in srgb, var(--sbox-accent, #0a84ff) 45%, #fff)' }} />
            <stop offset="40%" style={{ stopColor: 'color-mix(in srgb, var(--sbox-accent, #0a84ff) 72%, #fff)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--sbox-accent, #0a84ff)' }} />
          </linearGradient>
        </defs>
        <path d={shape.path} fill="none" stroke={`url(#${gradId})`} strokeWidth={3} strokeLinejoin="round" />
        <path d={shape.path} fill="var(--sbibata-body, #3a3630)" stroke="none" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
