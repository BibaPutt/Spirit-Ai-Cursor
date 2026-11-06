export const PROMPT_WIDTH = 440;
export const PROMPT_HEIGHT = 56;
export const PROMPT_MAX_HEIGHT = 380;
export const CURSOR_GAP = 28;
export const SCREEN_PADDING = 20;

export type AnchorBox = {
  x: number;
  y: number;
  flipLeft: boolean;
};

export function computeAnchor(
  cursorX: number,
  cursorY: number,
  screenW: number,
  screenH: number,
): AnchorBox {
  const flipLeft = cursorX + CURSOR_GAP + PROMPT_WIDTH > screenW - SCREEN_PADDING;
  const x = flipLeft ? cursorX - CURSOR_GAP - PROMPT_WIDTH : cursorX + CURSOR_GAP;

  // Vertical: aim for box vertically centered on cursor, but ensure room for full
  // expanded height. If we'd overflow the bottom, anchor with bottom near cursor.
  const idealY = cursorY - PROMPT_HEIGHT / 2;
  const maxY = screenH - PROMPT_MAX_HEIGHT - SCREEN_PADDING;
  const y = Math.max(SCREEN_PADDING, Math.min(maxY, idealY));

  return { x, y, flipLeft };
}
