import type { ChipVisibility } from '../../electron/types';

// Phase the prompt box is in right now. 'voice' = the Listening/Speaking
// capsule is the focus (arms mic, reads answers aloud); 'type' = the user is
// typing in the input row.
export type ChipPhase = 'voice' | 'type';

// "Setting rules everything": chip visibility is a pure function of the
// user's stored preference + the box's current phase. No mic-first special
// cases — 'voice' only shows during voice, 'type' only when typing,
// 'both' everywhere, 'off' never.
export function shouldShowChips(mode: ChipVisibility, phase: ChipPhase): boolean {
  if (mode === 'off') return false;
  if (mode === 'both') return true;
  return mode === phase;
}

// Main-side generation gate: only 'off' stops chips being generated at all
// (saves the OCR + LLM passes). 'voice'/'type' still generate — the renderer's
// shouldShowChips enforces the display rule.
export function isChipGenerationEnabled(mode: ChipVisibility): boolean {
  return mode !== 'off';
}