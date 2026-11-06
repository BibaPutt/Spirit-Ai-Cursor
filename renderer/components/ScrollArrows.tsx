// Overlay scroll arrows for Chromium/Electron, which cannot draw scrollbar
// buttons via CSS. Wraps a scroll container in a relative div and floats small
// accent chevrons at the top/bottom (vertical) or left/right (horizontal) of
// the viewport. Each arrow only appears while content actually overflows in
// that direction, and clicking scrolls by ~70% of the visible extent. The
// native scrollbar stays visible (styled thin + accent-gradient by globals.css).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

type Props = {
  // Classes for the scroll container (sizing + overflow), e.g.
  // "max-h-[360px] overflow-y-auto pr-1".
  className?: string;
  // Extra classes for the outer relative wrapper — use when the wrapper is a
  // flex child that must grow/shrink itself (e.g. "flex-1 min-h-0").
  outerClassName?: string;
  style?: CSSProperties;
  // Left/right arrows instead of top/bottom (for horizontal rows).
  horizontal?: boolean;
  children: ReactNode;
};

const chevron = (horizontal: boolean, end: boolean): ReactNode =>
  horizontal ? (
    end ? (
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    ) : (
      <path d="M7.5 2.5 4 6l3.5 3.5" />
    )
  ) : end ? (
    <path d="M2.5 4.5 6 8l3.5-3.5" />
  ) : (
    <path d="M2.5 7.5 6 4l3.5 3.5" />
  );

export function ScrollArrows({
  className = '',
  outerClassName = '',
  style,
  horizontal = false,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [canStart, setCanStart] = useState(false);
  const [canEnd, setCanEnd] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (horizontal) {
      setCanStart(el.scrollLeft > 4);
      setCanEnd(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
    } else {
      setCanStart(el.scrollTop > 4);
      setCanEnd(el.scrollTop < el.scrollHeight - el.clientHeight - 4);
    }
  }, [horizontal]);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, [update]);

  const scrollBy = useCallback(
    (dir: 1 | -1) => {
      const el = ref.current;
      if (!el) return;
      if (horizontal) {
        el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' });
      } else {
        el.scrollBy({ top: dir * el.clientHeight * 0.7, behavior: 'smooth' });
      }
    },
    [horizontal],
  );

  const arrow = (which: 'start' | 'end') => {
    const visible = which === 'start' ? canStart : canEnd;
    if (!visible) return null;
    const label = horizontal
      ? which === 'start'
        ? 'Scroll left'
        : 'Scroll right'
      : which === 'start'
        ? 'Scroll up'
        : 'Scroll down';
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => scrollBy(which === 'start' ? -1 : 1)}
        className={[
          'absolute z-10 flex h-[16px] w-[18px] items-center justify-center rounded-full',
          'border border-white/15 bg-white/10 text-white/80 shadow-sm backdrop-blur-md transition-colors',
          'hover:border-white/25 hover:bg-white/25 hover:text-white',
          // html.dark = LIGHT UI in this app (inverted convention). A near-black
          // pill reads as a harsh black dot here, so light mode gets a soft
          // white pill with a muted chevron instead.
          'dark:border-neutral-900/15 dark:bg-white/70 dark:text-neutral-600 dark:hover:bg-white dark:hover:text-neutral-900',
          horizontal
            ? which === 'start'
              ? 'left-0 top-1/2 -translate-y-1/2'
              : 'right-0 top-1/2 -translate-y-1/2'
            : which === 'start'
              ? 'right-1 top-0'
              : 'right-1 bottom-0',
        ].join(' ')}
      >
        <svg
          viewBox="0 0 12 12"
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {chevron(horizontal, which === 'end')}
        </svg>
      </button>
    );
  };

  return (
    // Flex column + min-h-0: the inner pane shrinks against the outer
    // maxHeight (passed via style) and actually scrolls. Plain h-full
    // against an auto-height parent resolves to content height, which
    // grows forever — no overflow, no scrollbar, no chevrons.
    <div className={['relative flex min-h-0 flex-col', outerClassName].filter(Boolean).join(' ')} style={style}>
      <div ref={ref} className={['min-h-0 flex-1', className].filter(Boolean).join(' ')}>
        {children}
      </div>
      {arrow('start')}
      {arrow('end')}
    </div>
  );
}
