// Zoom-refine (pass-2) precision for annotation tags — a two-pass refinement:
// a single vision call lands coordinates roughly-right (±30px on a downscaled
// image is typical), which is not enough for dense or icon-only targets
// (benzene rings, toolbar buttons, muscle diagrams). So each small tag that
// did NOT snap to a real scene element gets a focused crop around its
// estimate, upscaled, and re-aimed with a strict "return only x,y, ignore
// visually similar neighbors" prompt. The recovered point is mapped back into
// the screenshot's image pixels.
//
// Pure module — no Electron imports, no provider IO. Everything coordinates
// in the ANNOTATION image space (the same pixels the model was shown).

import type { AnnotationTag } from './point';
import type { SceneElement } from '../capture/scene';
import { matchElementByLabel } from './annotation-snap';

// One target to re-aim, expressed as a crop of the screenshot the model saw.
export type RefineCropSpec = {
  // index of the tag in the array passed to planRefineCrops
  tagIndex: number;
  // source label, kept for the second-pass prompt and logs
  label: string;
  // what part of the tag the crop is centered on
  model: 'point' | 'box' | 'arrow-head';
  // center of the target in IMAGE pixels (the pass-1 estimate)
  cx: number;
  cy: number;
  // integer crop rect, clamped inside the image
  crop: { x: number; y: number; w: number; h: number };
  // upscale factor applied to the crop for the second-pass call (>=1)
  scale: number;
  // size of the upscaled crop sent to the model
  outW: number;
  outH: number;
};

export type RefineOptions = {
  max?: number;
  // minimum crop side in image pixels
  cropMin?: number;
  // maximum crop side in image pixels
  cropMax?: number;
  // long edge the upscaled crop should reach
  upsampledLongEdge?: number;
  // maximum upscale factor
  maxScale?: number;
  // Round-2 re-aim centers (multi-hypothesis re-read): one per tag, aligned
  // with the tags array passed to planRefineCrops. A tag whose round-1 crop
  // missed the target (reply `none`/unparsed) is re-cropped at its entry here
  // — usually the nearest real content anchor picked by the annotation
  // resolver — and asked again. Null entries are not re-aimed.
  altCenters?: Array<{ x: number; y: number } | null>;
  // Indices of tags that already resolved to a REAL element frame (screen-*
  // geometry from near-snap/anchor-snap) — their pixel-perfect coordinates
  // make a second-pass LLM re-read pointless. Skipped by planRefineCrops.
  skipIndices?: ReadonlySet<number>;
};

export const REFINE_DEFAULTS = {
  max: 6,
  cropMin: 72,
  // Default cap for POINT/ARROW crops. Covers a first-pass slip of up to
  // ~170px (observed: ~100-150px on dense diagrams) so the target stays
  // INSIDE the crop; if the crop misses the target, pass-2 re-aims at
  // whatever nearest clutter sits there and guarantees a wrong chip.
  cropMax: 340,
  // BOXES get enough room to CONTAIN the whole box: the crop must fit every
  // pixel of the enclosed region so the second pass can MEASURE the box's
  // bounds (returns x,y,w,h), not just re-aim its center. Box tags often sit
  // in a wrong-scaled space (provider-resized / physical pixels), which makes
  // their w/h wrong by the same ratio — the only reliable size recovery is to
  // read the box's real pixels from the crop. The cap is raised from 480 so
  // an 801px-wide box fits entirely inside its crop (the old cap truncated it,
  // losing the very size we were trying to recover).
  boxCropMax: 1024,
  upsampledLongEdge: 480,
  maxScale: 4,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function tagCenter(t: AnnotationTag, imgW: number, imgH: number): { cx: number; cy: number; model: RefineCropSpec['model'] } | null {
  if (imgW <= 0 || imgH <= 0) return null;
  // Slightly-OOB estimates (a model writing just past the bottom/right edge of
  // the image) are clamped onto the image and still refined — dropping them
  // loses the exact tag the user asked about. Only wildly-off guesses stay
  // excluded (they'd refine against the wrong content).
  const margin = Math.round(Math.max(imgW, imgH) * 0.06);
  const clampPoint = (x: number, y: number): { cx: number; cy: number } | null => {
    const cx = Math.round(clamp(x, 0, Math.max(0, imgW - 1)));
    const cy = Math.round(clamp(y, 0, Math.max(0, imgH - 1)));
    if (Math.abs(x - cx) > margin || Math.abs(y - cy) > margin) return null;
    return { cx, cy };
  };
  switch (t.kind) {
    case 'point': {
      const c = clampPoint(t.x, t.y);
      return c ? { ...c, model: 'point' } : null;
    }
    case 'box': {
      if (t.w <= 0 || t.h <= 0) return null;
      const c = clampPoint(Math.round(t.x + t.w / 2), Math.round(t.y + t.h / 2));
      return c ? { ...c, model: 'box' } : null;
    }
    case 'arrow': {
      const c = clampPoint(t.x2, t.y2);
      return c ? { ...c, model: 'arrow-head' } : null;
    }
    case 'box-el':
      return null;
  }
}

// Decide which tags deserve a second-pass call. A tag is a candidate when it
// is a small, in-bounds, un-snapped target — the class the pass-1 estimate
// misses on dense/complex screens. Element-snapped tags are excluded (their
// coordinates come from a real UIA/AX/OCR frame, not a guess).
export function planRefineCrops(
  tags: AnnotationTag[],
  imgW: number,
  imgH: number,
  scene: SceneElement[] | null,
  opts: RefineOptions = {},
): RefineCropSpec[] {
  if (imgW <= 0 || imgH <= 0) return [];
  const { max, cropMin, cropMax, boxCropMax, upsampledLongEdge, maxScale } = {
    ...REFINE_DEFAULTS,
    ...opts,
  };
  const specs: RefineCropSpec[] = [];
  for (let i = 0; i < tags.length; i += 1) {
    if (specs.length >= max) break;
    if (opts.skipIndices?.has(i)) continue;
    const t = tags[i];
    // box-el tags resolve to real element frames — never refine a guess.
    if (t.kind === 'box-el') continue;
    const anchor = tagCenter(t, imgW, imgH);
    if (!anchor) continue;
    // Element-snappable labels are excluded: matchElementByLabel mirrors the
    // emit-time snap (with the same box-frame guard), so a refined guess would
    // just be discarded anyway.
    if (
      t.label &&
      matchElementByLabel(
        t.label,
        scene ?? [],
        anchor.cx,
        anchor.cy,
        t.kind === 'box' ? { x: t.x, y: t.y, w: t.w, h: t.h } : undefined,
      )
    ) {
      continue;
    }
    // Base the crop on the target's own footprint when the model drew a box
    // (it must fit ENTIRELY inside the crop, so box crops use a higher cap);
    // points and arrow heads otherwise get a fixed context window.
    let side =
      t.kind === 'box'
        ? Math.round(Math.max(t.w, t.h) * 1.6)
        : cropMin;
    const cap = t.kind === 'box' ? boxCropMax : cropMax;
    side = clamp(Math.round(side), Math.min(cropMin, 32), cap);
    const x1 = Math.round(anchor.cx - side / 2);
    const y1 = Math.round(anchor.cy - side / 2);
    const cx = clamp(x1, 0, Math.max(0, imgW - 1));
    const cy = clamp(y1, 0, Math.max(0, imgH - 1));
    const w = Math.min(side, imgW - cx);
    const h = Math.min(side, imgH - cy);
    // Clamped too far into a corner to be usable.
    if (w < Math.min(cropMin, 32) || h < Math.min(cropMin, 32)) continue;
    const scale = clamp(Math.ceil(upsampledLongEdge / Math.max(w, h)), 1, maxScale);
    specs.push({
      tagIndex: i,
      label: t.label,
      model: anchor.model,
      cx: anchor.cx,
      cy: anchor.cy,
      crop: { x: cx, y: cy, w, h },
      scale,
      outW: w * scale,
      outH: h * scale,
    });
  }
  return specs;
}

// A single crop centered on an arbitrary point (round-2 of the
// multi-hypothesis re-read). When a round-1 crop missed the target (reply
// "none"/unparsed), the annotation resolver picks the nearest real content
// anchor to the estimate and this builds a fresh crop there. The window is a
// generous fixed context: the provisional center is only an estimate, so it
// must swallow more than a tight footprint-sized window would.
export function refineSpecForCenter(
  tagIndex: number,
  cx: number,
  cy: number,
  label: string,
  model: RefineCropSpec['model'],
  imgW: number,
  imgH: number,
  opts: RefineOptions = {},
): RefineCropSpec | null {
  if (imgW <= 0 || imgH <= 0) return null;
  const { cropMin, cropMax, upsampledLongEdge, maxScale } = { ...REFINE_DEFAULTS, ...opts };
  if (cx < 0 || cy < 0 || cx > imgW || cy > imgH) return null;
  const side = Math.round(cropMax);
  const x1 = clamp(Math.round(cx - side / 2), 0, Math.max(0, imgW - 1));
  const y1 = clamp(Math.round(cy - side / 2), 0, Math.max(0, imgH - 1));
  const w = Math.min(side, imgW - x1);
  const h = Math.min(side, imgH - y1);
  if (w < Math.min(cropMin, 32) || h < Math.min(cropMin, 32)) return null;
  const scale = clamp(Math.ceil(upsampledLongEdge / Math.max(w, h)), 1, maxScale);
  return {
    tagIndex,
    label,
    model,
    cx,
    cy,
    crop: { x: x1, y: y1, w, h },
    scale,
    outW: w * scale,
    outH: h * scale,
  };
}

// Parse the second-pass reply: two integers (= x,y CENTER) or four integers
// (= x,y,w,h BOX BOUNDS, top-left + size) in CROP pixels, or an explicit
// "none"/"nope"/empty when the target isn't in the crop. Small models rarely
// reply with the bare `x,y` line we first demanded — they answer in prose
// ("The center is roughly at 142, 88") — which made every real run report
// `0/8 re-aimed`. The FIRST integer pair in the reply is taken as the
// coordinate (a box reply's four integers are read as bounds); anything
// without a pair, or an explicit none/not-present answer, is treated as a
// miss — a wrong answer is worse than no answer.
export type RefineReply = { x: number; y: number; w?: number; h?: number };

export function parseRefineReply(text: string): RefineReply | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^(none|n\/a|nope|not present|missing|unclear|uncertain|cannot see|can't see|not.*visible|no)\b/i.test(trimmed)) {
    return null;
  }
  const m = trimmed.match(/(\d{1,4})\s*[,;\s]\s*(\d{1,4})(?:\s*[,;\s]\s*(\d{1,4})\s*[,;\s]\s*(\d{1,4}))?/);
  if (!m) return null;
  const x = parseInt(m[1], 10);
  const y = parseInt(m[2], 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = m[3] !== undefined && m[4] !== undefined ? parseInt(m[3], 10) : undefined;
  const h = m[3] !== undefined && m[4] !== undefined ? parseInt(m[4], 10) : undefined;
  const reply: RefineReply = { x, y };
  if (w !== undefined && h !== undefined && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    reply.w = w;
    reply.h = h;
  }
  return reply;
}

export type RefineOutcome = {
  spec: RefineCropSpec;
  result: RefineReply | null;
  // Pixels of the PAYLOAD the result was measured in, per image pixel. When
  // the payload was an upsampled copy of the downscaled crop this equals
  // spec.scale; when it was a NATIVE-resolution crop of the same screen the
  // IO layer sets a denser ratio. Absent ⇒ applyRefineResults falls back to
  // spec.scale (the upsampled-crop case).
  pxPerImage?: number;
};

// Rewrite a run's tags with the second-pass results. `results` is keyed by
// spec.tagIndex (missing index ⇒ that tag is left untouched). Result
// coordinates are in crop payload PIXELS — either the upscaled image-space
// crop (dividing by spec.scale) or a native-resolution crop of the same
// screen (dividing by outcome.pxPerImage — the payload's pixels per image
// pixel). Both map to the screenshot image, then clamp so nothing lands
// off-canvas.
export function applyRefineResults(
  tags: AnnotationTag[],
  outcomes: RefineOutcome[],
  imgW: number,
  imgH: number,
): AnnotationTag[] {
  if (outcomes.length === 0) return tags;
  const byIndex = new Map<number, RefineOutcome>();
  for (const o of outcomes) byIndex.set(o.spec.tagIndex, o);
  const refinedToPixel = (outcome: RefineOutcome, rx: number, ry: number): { px: number; py: number } => {
    const per = outcome.pxPerImage ?? outcome.spec.scale;
    return {
      px: outcome.spec.crop.x + rx / per,
      py: outcome.spec.crop.y + ry / per,
    };
  };
  const inImage = (px: number, py: number): [number, number] => [
    clamp(Math.round(px), 0, Math.max(0, imgW)),
    clamp(Math.round(py), 0, Math.max(0, imgH)),
  ];
  return tags.map((t, i) => {
    const outcome = byIndex.get(i);
    if (!outcome?.result) return t;
    const { spec, result } = outcome;
    const { px, py } = refinedToPixel(outcome, result.x, result.y);
    switch (t.kind) {
      case 'point': {
        const [x, y] = inImage(px, py);
        return { ...t, x, y };
      }
      case 'box': {
        if (result.w !== undefined && result.h !== undefined) {
          // The second pass MEASURED the box's bounds in the crop. The tag's
          // original w/h may live in the WRONG scaled space (provider-resized /
          // physical pixels — the "zoomed box is the right spot but the wrong
          // size" case), so the measured size is authoritative. Re-scale both
          // the top-left and the size from payload → image px, then clamp so
          // the whole box stays on-canvas.
          const per = outcome.pxPerImage ?? spec.scale;
          const sx = spec.crop.x + result.x / per;
          const sy = spec.crop.y + result.y / per;
          const sw = Math.max(1, result.w / per);
          const sh = Math.max(1, result.h / per);
          const x = clamp(Math.round(sx), 0, Math.max(0, imgW - Math.round(sw)));
          const y = clamp(Math.round(sy), 0, Math.max(0, imgH - Math.round(sh)));
          return { ...t, x, y, w: Math.round(sw), h: Math.round(sh) };
        }
        // Legacy fallback: no measured bounds — re-center the original box on
        // the refined center, clamped inside the image so an edge-adjacent
        // target keeps its chip.
        const [cx, cy] = inImage(px, py);
        const x = clamp(cx - Math.round(t.w / 2), 0, Math.max(0, imgW - t.w));
        const y = clamp(cy - Math.round(t.h / 2), 0, Math.max(0, imgH - t.h));
        return { ...t, x, y };
      }
      case 'arrow': {
        // Refine the head; the tail stays where the model put it.
        const [x2, y2] = inImage(px, py);
        return { ...t, x2, y2 };
      }
      case 'box-el':
        return t;
    }
  });
}