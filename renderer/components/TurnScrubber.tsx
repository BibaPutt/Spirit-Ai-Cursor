import * as React from 'react';
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import { cn } from '../lib/utils';

// Past-question rail for the answer area: one tick per committed turn on the
// left edge. Hover magnifies ticks around the pointer (raised-cosine wave)
// and shows a preview card; click/Enter jumps to that turn. Spirit-styled
// (glass tokens, accent current-tick) and compact for the 380px box.

export interface TurnChapter {
  /** Stable, unique identifier (the turn id). */
  id: string;
  /** Bold heading (the question, truncated by the caller). */
  title: string;
  /** Supporting copy under the title (answer snippet). */
  description?: React.ReactNode;
  /** Small muted label above the title (e.g. "Q1"). */
  meta?: React.ReactNode;
}

export interface TurnScrubberProps {
  chapters: TurnChapter[];
  side?: 'left' | 'right';
  peakLength?: number;
  restLength?: number;
  rowHeight?: number;
  radius?: number;
  /** The live/latest turn, marked persistent. */
  currentIndex?: number;
  onActiveChange?: (chapter: TurnChapter | null, index: number) => void;
  onSelect?: (chapter: TurnChapter, index: number) => void;
  label?: string;
  className?: string;
}

const CARD_WIDTH = 240;
const GAP = 12;
const POINTER_SPRING = { stiffness: 700, damping: 52, mass: 0.5 };
const STRENGTH_SPRING = { stiffness: 260, damping: 30, mass: 0.6 };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function bump(distance: number, radius: number) {
  if (distance >= radius) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (distance / radius)));
}

interface TickProps {
  index: number;
  pointer: MotionValue<number>;
  strength: MotionValue<number>;
  radius: number;
  restLength: number;
  peakLength: number;
  isCurrent: boolean;
}

const Tick = React.memo(function Tick({
  index,
  pointer,
  strength,
  radius,
  restLength,
  peakLength,
  isCurrent,
}: TickProps) {
  const width = useTransform(() => {
    const rise = strength.get() * bump(Math.abs(index - pointer.get()), radius);
    return restLength + rise * (peakLength - restLength);
  });
  const opacity = useTransform(() => {
    const rise = strength.get() * bump(Math.abs(index - pointer.get()), radius);
    const base = isCurrent ? 0.6 : 0.25;
    return base + rise * (1 - base);
  });
  // Accent halo swelling with the crest — the wave glows, not just grows.
  const glow = useTransform(() => strength.get() * bump(Math.abs(index - pointer.get()), radius));
  const glowPx = useTransform(glow, (g) => g * 8);
  const glowColor = useTransform(
    glow,
    (g) => `rgba(var(--spirit-accent-rgb) / ${(g * 0.9).toFixed(3)})`,
  );
  const boxShadow = useMotionTemplate`0 0 ${glowPx}px ${glowColor}`;

  return (
    <motion.span
      aria-hidden="true"
      style={{ width, opacity, boxShadow }}
      className={cn(
        'block h-[2px] rounded-full',
        // Contrast halo behind the tick so it reads apart from answer text:
        // dark shadow on the dark UI, white shadow on the light UI
        // (remember: `dark:` variant here IS the light theme).
        'drop-shadow-[0_0_3px_rgba(0,0,0,0.9)] dark:drop-shadow-[0_0_3px_rgba(255,255,255,0.9)]',
        isCurrent ? 'bg-[rgb(var(--spirit-accent-rgb))]' : 'bg-white/70 dark:bg-neutral-900/60',
      )}
    />
  );
});

export function TurnScrubber({
  chapters,
  side = 'left',
  peakLength = 28,
  restLength = 8,
  rowHeight = 12,
  radius = 4,
  currentIndex,
  onActiveChange,
  onSelect,
  label = 'Past questions',
  className,
}: TurnScrubberProps) {
  const prefersReducedMotion = useReducedMotion();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const buttonsRef = React.useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = React.useId();
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const rawPointer = useMotionValue(0);
  const rawStrength = useMotionValue(0);
  const springPointer = useSpring(rawPointer, POINTER_SPRING);
  const springStrength = useSpring(rawStrength, STRENGTH_SPRING);
  const pointer = prefersReducedMotion ? rawPointer : springPointer;
  const strength = prefersReducedMotion ? rawStrength : springStrength;

  const [activeIndex, setActiveIndex] = React.useState(0);
  const [engaged, setEngaged] = React.useState(false);
  const [flipped, setFlipped] = React.useState(false);
  const [cardHeight, setCardHeight] = React.useState(0);
  const hoveringRef = React.useRef(false);
  const focusedRef = React.useRef<number | null>(null);
  const activeRef = React.useRef(0);

  const commitActive = React.useCallback((index: number) => {
    if (index !== activeRef.current) {
      activeRef.current = index;
      setActiveIndex(index);
    }
  }, []);

  const last = chapters.length - 1;

  React.useEffect(() => {
    onActiveChange?.(engaged ? chapters[activeIndex] : null, engaged ? activeIndex : -1);
  }, [engaged, activeIndex, chapters, onActiveChange]);

  React.useEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight);
  }, [activeIndex]);

  React.useEffect(() => {
    if (!engaged) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = el.ownerDocument.defaultView?.innerWidth ?? 0;
    const need = CARD_WIDTH + GAP + 8;
    let useRight = side === 'right';
    if (useRight && vw - rect.right < need && rect.left >= need) useRight = false;
    if (!useRight && rect.left < need && vw - rect.right >= need) useRight = true;
    setFlipped(useRight !== (side === 'right'));
  }, [engaged, activeIndex, side]);

  const resolvedSide =
    side === 'right' ? (flipped ? 'left' : 'right') : flipped ? 'right' : 'left';

  const totalHeight = chapters.length * rowHeight;
  const rovingIndex = engaged ? activeIndex : (currentIndex ?? 0);

  // Card hangs BELOW the hovered tick (never centered on it), clamped so
  // it never spills past the rail top/bottom or the overlay height.
  const cardTop = useTransform(pointer, (p) => {
    const top = (p + 0.5) * rowHeight + 6;
    return clamp(top, 0, Math.max(0, totalHeight - cardHeight));
  });
  const cardScale = useTransform(strength, [0, 1], [0.97, 1]);
  const cardX = useTransform(strength, [0, 1], [resolvedSide === 'right' ? -6 : 6, 0]);

  const engageAt = (pointerRow: number, activeAt: number) => {
    rawPointer.set(pointerRow);
    rawStrength.set(1);
    commitActive(clamp(activeAt, 0, Math.max(last, 0)));
    if (!engaged) setEngaged(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = listRef.current;
    if (!el || last < 0) return;
    const rect = el.getBoundingClientRect();
    const row = (event.clientY - rect.top) / rowHeight - 0.5;
    hoveringRef.current = true;
    engageAt(clamp(row, -0.5, last + 0.5), Math.round(row));
  };

  const handlePointerLeave = () => {
    hoveringRef.current = false;
    if (focusedRef.current != null) {
      rawPointer.set(focusedRef.current);
    } else {
      rawStrength.set(0);
      setEngaged(false);
    }
  };

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      focusedRef.current = null;
      if (!hoveringRef.current) {
        rawStrength.set(0);
        setEngaged(false);
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next = focusedRef.current ?? activeRef.current;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = Math.min(last, next + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = Math.max(0, next - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttonsRef.current[next]?.focus();
  };

  if (chapters.length === 0) return null;

  return (
    <div
      ref={containerRef}
      style={{ width: peakLength + 8 }}
      className={cn('relative flex h-full shrink-0 flex-col justify-center', className)}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        aria-orientation="vertical"
        aria-activedescendant={engaged ? optionId(activeIndex) : undefined}
        className="relative z-10 flex w-full flex-col justify-center py-1"
        style={{ minHeight: totalHeight }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      >
        {chapters.map((chapter, index) => {
          const isCurrent = index === currentIndex;
          const descText = typeof chapter.description === 'string' ? `. ${chapter.description}` : '';
          return (
            <button
              ref={(el) => {
                buttonsRef.current[index] = el;
              }}
              key={chapter.id}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={isCurrent}
              aria-label={`${chapter.title}${descText}`}
              tabIndex={index === rovingIndex ? 0 : -1}
              onFocus={() => {
                focusedRef.current = index;
                engageAt(index, index);
              }}
              onClick={() => onSelect?.(chapter, index)}
              style={{ height: rowHeight }}
              className={cn(
                'flex w-full items-center rounded-sm outline-none',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--spirit-accent-rgb))]',
                resolvedSide === 'left' ? 'justify-end' : 'justify-start',
              )}
            >
              <Tick
                index={index}
                pointer={pointer}
                strength={strength}
                radius={radius}
                restLength={restLength}
                peakLength={peakLength}
                isCurrent={isCurrent}
              />
            </button>
          );
        })}
      </div>

      {chapters[activeIndex] ? (
        <motion.div
          ref={cardRef}
          aria-hidden="true"
          style={{
            top: cardTop,
            x: cardX,
            scale: cardScale,
            opacity: strength,
            ...(resolvedSide === 'right' ? { left: peakLength + GAP } : { right: peakLength + GAP }),
          }}
          className={cn(
            'pointer-events-none absolute z-10 w-[240px] rounded-2xl spirit-glass-chip border border-white/15 px-3.5 py-3 text-white shadow-glass dark:border-neutral-900/20 dark:text-neutral-900',
            resolvedSide === 'right' ? 'origin-left' : 'origin-right',
          )}
        >
          {chapters[activeIndex].meta ? (
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[rgb(var(--spirit-accent-rgb))]">
              {chapters[activeIndex].meta}
            </div>
          ) : null}
          <div className="truncate text-[13px] font-semibold leading-snug tracking-[-0.01em]">
            {chapters[activeIndex].title}
          </div>
          {chapters[activeIndex].description ? (
            <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-white/65 dark:text-neutral-900/65">
              {chapters[activeIndex].description}
            </p>
          ) : null}
        </motion.div>
      ) : null}
    </div>
  );
}

export default TurnScrubber;
