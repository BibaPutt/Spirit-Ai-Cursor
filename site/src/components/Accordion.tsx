import { useEffect, useId, useRef, useState } from 'react';

export interface AccordionItem {
  title: string;
  body: string;
}

interface AccordionProps {
  items: AccordionItem[];
  defaultOpen?: number | null;
  auto?: boolean;
}

export default function Accordion({ items, defaultOpen = null, auto = false }: AccordionProps) {
  const [open, setOpen] = useState<number | null>(defaultOpen);
  const rows = useRef<Array<HTMLDivElement | null>>([]);
  const manualUntil = useRef(0);
  const base = useId();

  useEffect(() => {
    if (!auto) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      if (Date.now() < manualUntil.current) return;
      const mid = window.innerHeight * 0.52;
      let next: number | null = null;
      rows.current.forEach((row, index) => {
        if (!row) return;
        const box = row.getBoundingClientRect();
        if (box.top <= mid && box.bottom >= mid) next = index;
      });
      if (next === null) return;
      setOpen((current) => (current === next ? current : next));
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [auto, items.length]);

  return (
    <div className="rows">
      {items.map((item, index) => {
        const expanded = open === index;
        const panelId = `${base}-panel-${index}`;
        const buttonId = `${base}-button-${index}`;

        return (
          <div
            className={`row${expanded ? ' is-open' : ''}`}
            key={item.title}
            ref={(node) => {
              rows.current[index] = node;
            }}
          >
            <button
              type="button"
              className="row__head"
              id={buttonId}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => {
                manualUntil.current = Date.now() + 2400;
                setOpen(expanded ? null : index);
              }}
            >
              <span className="row__title">{item.title}</span>
              <span className="row__mark" aria-hidden="true">
                <span />
                <span />
              </span>
            </button>
            <div className="row__panel" id={panelId} role="region" aria-labelledby={buttonId}>
              <div className="row__inner">
                <p>{item.body}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
