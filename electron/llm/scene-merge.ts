// Merge multiple scene layers into one element list for annotation snapping.
// The annotate path is fed from several sources — the OCR grounding for the
// screenshot (scene-cache.ts) and the accessibility walk of the user's window
// (buildScene) — and both can describe the same physical control ("Play" as an
// OCR phrase AND as a UIA element). Duplicates must collapse so label matching
// never has to guess between two boxes around the same spot.
//
// Pure module — no Electron imports, unit-tested in isolation.

import type { SceneElement } from '../capture/scene';

// Proximity (in the elements' coordinate space, absolute screen DIP) below
// which two elements are considered the same physical control. OCR word boxes
// and UIA frames of the same control agree to a few pixels.
const DUP_RADIUS = 12;
const DUP_RADIUS_SQ = DUP_RADIUS * DUP_RADIUS;

function near(a: SceneElement, b: SceneElement): boolean {
  if (typeof a.center?.[0] !== 'number' || typeof b.center?.[0] !== 'number') return false;
  const dx = a.center[0] - b.center[0];
  const dy = a.center[1] - b.center[1];
  return dx * dx + dy * dy <= DUP_RADIUS_SQ;
}

// Merge ordered layers, first occurrence wins. Elements are kept in layer
// order (so passing [uia, ocr] prefers the accessibility frame over the OCR
// box for any control both know about), and any later element that sits on
// top of an already-merged center is dropped as a duplicate.
export function mergeSceneLayers(layers: (SceneElement[] | null | undefined)[]): SceneElement[] {
  const merged: SceneElement[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    for (const el of layer) {
      if (merged.some((m) => near(m, el))) continue;
      merged.push(el);
    }
  }
  return merged;
}