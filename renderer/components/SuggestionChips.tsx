import { memo } from 'react';
import { motion } from 'framer-motion';
import type { SuggestionChip } from '../../electron/types';
import { fuzzyResolveIcon } from '../lib/iconMatch';

type Props = {
  chips: SuggestionChip[];
  // Hide the whole row while the LLM is working (a chip tap submits, so the
  // suggestions disappear the moment one is used).
  busy: boolean;
  // RESULT MODE: render as a fixed-width vertical rail on the RIGHT of the
  // box (top-aligned) instead of the full-width row under it. Chips fill the
  // rail width and truncate their labels instead of stretching it.
  rail?: boolean;
  // Tapping a chip hands the whole chip up: the label is the display text, the
  // hidden `prompt` is what gets submitted when present, and `web` lets a chip
  // force web search for the run.
  onRun: (chip: SuggestionChip) => void;
};

// Action suggestion chips: capsule pills stacked below the prompt box (same
// draggable parent, so they follow the box when it moves). Nothing renders
// until real chips arrive — no placeholder skeletons. Each pill drops in from
// above, cascading top-to-bottom (first chip lands first, then the ones under
// it), matching the box's own downward unfold. In result mode (`rail`) the
// same pills become the right-side context rail.
export const SuggestionChips = memo(function SuggestionChips({
  chips,
  busy,
  rail,
  onRun,
}: Props) {
  if (busy || chips.length === 0) return null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={[
        rail
          ? 'flex flex-col items-stretch gap-1.5 pt-1.5 pr-1'
          : 'flex flex-col items-start gap-1.5 px-3.5 pb-1',
      ].join(' ')}
    >
      {chips.map((chip, i) => {
        const Icon = fuzzyResolveIcon(chip.icon);
        return (
          <motion.button
            key={chip.label}
            layout
            initial={{ opacity: 0, y: -14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.22, ease: 'easeOut', delay: i * 0.05 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => onRun(chip)}
            className={[
              'flex cursor-pointer items-center gap-1.5 rounded-full border border-white/15 px-3 py-1.5 text-left text-[12px] font-semibold leading-none text-white shadow-glass ring-1 ring-inset ring-white/10 transition-colors hover:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--spirit-accent-rgb))] dark:border-neutral-900/25 dark:text-neutral-800 dark:ring-neutral-900/15 dark:hover:text-neutral-900',
              'spirit-glass-chip',
              rail ? 'w-full' : '',
            ].join(' ')}
            title={chip.label}
          >
            <Icon
              size={14}
              stroke={2}
              style={{ color: 'rgb(var(--spirit-accent-rgb) / 0.95)' }}
              className="shrink-0"
            />
            <span className={rail ? 'min-w-0 flex-1 truncate' : 'max-w-[280px] truncate'}>
              {chip.label}
            </span>
          </motion.button>
        );
      })}
    </motion.div>
  );
});
