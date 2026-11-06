import { memo } from 'react';
import type { SuggestionChip } from '../../electron/types';
import { fuzzyResolveIcon } from '../lib/iconMatch';
import { ScrollArrows } from './ScrollArrows';

type Props = {
  chips: SuggestionChip[];
  // Hide while the LLM is working (a tap submits, so the row clears the
  // moment one is used).
  busy: boolean;
  // Tapping a chip hands the whole chip up (label = display text, hidden
  // `prompt` = what gets submitted when present, `web` forces web search).
  onRun: (chip: SuggestionChip) => void;
};

// Post-response "next action" chips: parsed from the [NEXT_ACTIONS] block the
// answering model appends, shown as a horizontal scrollable row BETWEEN the
// text field and the result (so a finished answer doesn't grow the box any
// taller). Same icon-first capsule language as the under-box chips, keyed to
// the frosted glass surface they sit on.
export const NextActionChips = memo(function NextActionChips({
  chips,
  busy,
  onRun,
}: Props) {
  if (busy || chips.length === 0) return null;

  return (
    <div className="border-t border-white/8 px-3.5 py-2">
      <ScrollArrows horizontal className="-mx-0.5 flex gap-1.5 overflow-x-auto px-0.5 pb-0.5">
        {chips.map((chip) => {
          const Icon = fuzzyResolveIcon(chip.icon);
          return (
            <button
              key={chip.label}
              onClick={() => onRun(chip)}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-white/12 bg-white/8 px-2.5 py-1 text-left text-[11px] font-semibold leading-none text-white/95 backdrop-blur-md transition-colors hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--spirit-accent-rgb))] dark:border-neutral-900/20 dark:bg-neutral-900/10 dark:text-neutral-800 dark:hover:bg-neutral-900/20 dark:hover:text-neutral-900"
              title={chip.label}
            >
              <Icon
                size={13}
                stroke={2}
                style={{ color: 'rgb(var(--spirit-accent-rgb) / 0.95)' }}
                className="shrink-0"
              />
              <span className="whitespace-nowrap">{chip.label}</span>
            </button>
          );
        })}
      </ScrollArrows>
    </div>
  );
});
