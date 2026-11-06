import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SpiritAnnotation } from '../../lib/spirit';

type Measured = {
  n: number;
  kind: SpiritAnnotation['kind'];
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export default function AnnotationFrame({
  annotations,
  className = '',
}: {
  annotations: SpiritAnnotation[];
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<Measured[]>([]);
  const [on, setOn] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || annotations.length === 0) {
      setItems([]);
      setOn(false);
      return;
    }
    const rootBox = root.getBoundingClientRect();
    // The sann div is an absolutely-positioned overlay; the marked targets
    // are its siblings inside the stage, so the search scope is the parent.
    const scope = root.parentElement ?? root;
    const next: Measured[] = [];
    for (const a of annotations) {
      const el = scope.querySelector<HTMLElement>(`[data-sann-target="${a.target}"]`);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      next.push({
        n: a.n ?? next.length + 1,
        kind: a.kind,
        label: a.label,
        x: b.left - rootBox.left,
        y: b.top - rootBox.top,
        w: b.width,
        h: b.height,
      });
    }
    setItems(next);
    const t = window.setTimeout(() => setOn(true), 30);
    return () => window.clearTimeout(t);
  }, [annotations]);

  useEffect(() => {
    if (annotations.length === 0) setOn(false);
  }, [annotations]);

  if (annotations.length === 0) return null;

  return (
    <div ref={rootRef} className={`sann${on ? ' is-on' : ''} ${className}`.trim()} aria-hidden="true">
      {items.map((m) => (
        <div
          key={`${m.kind}-${m.n}-${m.label}`}
          style={{
            position: 'absolute',
            left: m.x,
            top: m.y,
            width: m.w,
            height: m.h,
          }}
        >
          {(m.kind === 'box' || m.kind === 'chip') && (
            <span className="sann__box" />
          )}
          {(m.kind === 'chip' || m.kind === 'box') && (
            <span className="sann__chip" style={{ top: -10, left: -6 }}>
              <span className="sann__num">{m.n}</span>
              {m.label}
            </span>
          )}
          {m.kind === 'arrow' && (
            <>
              <span className="sann__box" />
              <span className="sann__arrow" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function withAnnotationTarget(
  children: ReactNode,
  _targets?: string[],
): ReactNode {
  return children;
}