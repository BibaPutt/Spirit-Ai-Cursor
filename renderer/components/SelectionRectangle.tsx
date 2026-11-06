import { motion } from 'framer-motion';

type Props = {
  x: number;
  y: number;
  width: number;
  height: number;
  // 'lime' = trigger-held screenshot selection (legacy default), 'accent' =
  // paint-to-select region — tinted with the user's accent color.
  tone?: 'lime' | 'accent';
};

// Visual rectangle the user is drawing while drag-selecting a region.
// Sits on top of the click-through overlay so it doesn't obstruct the
// underlying app being framed. Fill is intentionally near-transparent so the
// screenshot isn't tinted; the stroke carries the visibility.
export function SelectionRectangle({ x, y, width, height, tone = 'lime' }: Props) {
  const accent = tone === 'accent';
  const stroke = accent
    ? 'rgba(var(--spirit-accent-rgb), 0.95)'
    : 'rgba(167,245,107,0.95)';
  const strokeSoft = accent
    ? 'rgba(var(--spirit-accent-rgb), 0.45)'
    : 'rgba(167,245,107,0.18)';
  const glow = accent
    ? `0 0 0 1px ${strokeSoft}, 0 8px 36px -8px rgba(var(--spirit-accent-rgb), 0.45), inset 0 0 0 1px rgba(255,255,255,0.04)`
    : '0 0 0 1px rgba(167,245,107,0.18), 0 8px 36px -8px rgba(167,245,107,0.45), inset 0 0 0 1px rgba(255,255,255,0.04)';
  const fill = accent
    ? 'rgb(var(--spirit-accent-rgb) / 0.16)'
    : 'linear-gradient(135deg, rgba(167,245,107,0.06) 0%, rgba(167,245,107,0.02) 100%)';
  const labelColor = accent ? 'rgb(var(--spirit-accent-rgb))' : 'rgba(167,245,107,0.95)';
  return (
    <motion.div
      className="pointer-events-none absolute z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.08 }}
      style={{
        left: x,
        top: y,
        width,
        height,
        borderRadius: 8,
        border: `1.5px solid ${stroke}`,
        background: fill,
        boxShadow: glow,
        willChange: 'left, top, width, height',
      }}
    >
      <div
        className="absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none"
        style={{
          background: 'rgba(20,22,18,0.78)',
          color: labelColor,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        {Math.round(width)} × {Math.round(height)}
      </div>
    </motion.div>
  );
}
