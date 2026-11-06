// Auto-snap named annotation tags to REAL scene elements (Phase 7 accuracy).
// When the model writes a pixel [POINT]/[BOX] with a label that names an
// element from the most recent ui_read/see_screen scene, main snaps the tag to
// that element's true frame instead of trusting the guessed pixel. This turns
// "Close button" (guessed 1329,215 → 500px off) into an exact UIA/AX/OCR box.
//
// Pure module — no Electron imports; elements are passed in so it unit-tests
// in isolation.

import type { SceneElement } from '../capture/scene';

// Minimum label length before we'll trust a name match. Two-letter formulas
// ("C=O") and tiny technical labels are intentionally excluded — a 2-char
// "ok" can substring-match half an accessibility tree.
const MIN_MATCH_LENGTH = 3;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Conservative guard for BOX tags: never glue a drawn box onto a merged OCR
// row-frame that doesn't overlap it. OCR merges whole table/caption rows into
// single very-wide frames ("Benzene | Cl2 | FeCl3 | …" spanning the column);
// snapping a structure box onto such a row anchors the chip to unrelated text
// far from the drawn region. A candidate is "row-like" when it is much wider
// than tall (a single text line in image pixels); a [BOX] tag's drawn frame
// must overlap it (50% dilation) for the snap to fire. Thin word/heading
// frames ("Bonds Formed Summary") are unaffected. Point tags pass no frame and
// are unguarded — a name-beats-pixels point snap stays as before.
export function rowLike(el: SceneElement): boolean {
  const w = el.bounds[2] - el.bounds[0];
  const h = el.bounds[3] - el.bounds[1];
  return w >= 400 && h > 0 && h <= 40;
}

function overlaps(
  box: { x: number; y: number; w: number; h: number },
  b: [number, number, number, number],
  dilation: number,
): boolean {
  const dw = box.w * dilation;
  const dh = box.h * dilation;
  const left = box.x - dw;
  const top = box.y - dh;
  const right = box.x + box.w + dw;
  const bottom = box.y + box.h + dh;
  return !(right < b[0] || left > b[2] || bottom < b[1] || top > b[3]);
}

// Best-matching scene element for a tag label. Matching is permissive but
// guarded: exact normalized equality wins; otherwise one side must contain the
// other (either direction, so "Downloads" hits "Downloads folder" and vice
// versa) and only labels ≥ MIN_MATCH_LENGTH qualify. Ties (the classic
// "Save" vs "Save as…") are broken by distance to the tag's own attempted
// coordinates; a tie at the same spot falls back to the first element.
export function matchElementByLabel(
  label: string,
  elements: SceneElement[],
  atX?: number,
  atY?: number,
  boxFrame?: { x: number; y: number; w: number; h: number },
  usedIds?: Set<string>,
): SceneElement | null {
  const target = normalize(label);
  if (!target || target.length < MIN_MATCH_LENGTH || elements.length === 0) return null;

  const seen = new Set<string>();
  const candidates: { el: SceneElement; score: number }[] = [];
  for (const el of elements) {
    const name = normalize(el.name);
    // Never return an element another tag already claimed this group.
    if (!name || name.length < MIN_MATCH_LENGTH || seen.has(el.id)) continue;
    if (usedIds && usedIds.has(el.id)) continue;
    seen.add(el.id);
    // Box tags must overlap a row-like frame to snap to it (see rowLike).
    if (boxFrame && rowLike(el) && !overlaps(boxFrame, el.bounds, 0.5)) continue;
    if (name === target) {
      usedIds?.add(el.id);
      return el;
    }
    if (name.includes(target) || target.includes(name)) {
      candidates.push({ el, score: dist2(el.center, atX, atY) });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  usedIds?.add(candidates[0].el.id);
  return candidates[0].el;
}

function dist2(center: [number, number], x?: number, y?: number): number {
  if (typeof x !== 'number' || typeof y !== 'number') return 0;
  const dx = center[0] - x;
  const dy = center[1] - y;
  return dx * dx + dy * dy;
}