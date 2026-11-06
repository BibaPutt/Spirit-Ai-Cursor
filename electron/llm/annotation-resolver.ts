// Grounded Annotation Resolver — the final-pass architecture that maps the
// model's pixel guesses onto REAL screen anchors instead of trusting pixel
// accuracy. It replaces the bolt-on emit-time snap with one deterministic
// decision per tag, then corrects the whole GROUP:
//
//  1. NEAR-SNAP: a tag whose label names a real scene/OCR element whose frame
//     sits near the guess (<= NEAR_RADIUS) is glued to that frame's TRUE box.
//     A matching element that is far away is IGNORED — a caption on the far
//     side of the screen can never again pull a structure chip across itself
//     (the "benzene box landing on a table row" bug).
//  2. ZOOM-REFINE: only the tags that could NOT be glued (structures, rings,
//     icons — anchorless targets) get the slow second-pass re-read, and when
//     a crop misses, it is re-aimed once at the nearest real content.
//  3. GROUP CALIBRATION: every snap and every refined tag yields a
//     (hint -> true) pair. The provider silently resizes the screenshot it
//     sees, so a whole run's guesses share ONE systematic shift; a handful of
//     pairs measures it and every still-unplaced tag is moved by it. A run
//     whose chips form the right SHAPE but sit left of the real spots lands
//     exactly — no more fighting the model for each point.
//
// Pure module — no Electron imports, no provider IO. The async orchestrator
// that runs resolution → zoom-refine → calibration for a whole tag group lives
// in point-refine.ts (it owns the provider calls) and composes these pieces.

import type { AnnotationTag, PointGeo } from './point';
import { regionCropScale } from './point';
import type { SceneElement } from '../capture/scene';
import { matchElementByLabel, rowLike } from './annotation-snap';

// A label match only counts when the element's frame is THIS near the guess
// (image pixels). Observed pass-1 slips are ~100-150px; this covers them while
// still rejecting every far-away caption. This is the "glue only when close"
// rule made concrete.
export const NEAR_RADIUS = 320;

// POINT tags glue on a tighter basis than boxes: a point that lands on a
// drawing/structure whose label also names some caption text must NOT be
// yanked onto that text. A point only snaps when its guessed pixel is inside
// the matched frame (dilated) or within this many image px of the frame's
// center. The primary path is "the guess is ON the frame" (buttons, icons —
// everything normal); the radius only rescues mildly-missed guesses while
// rejecting the observed +148-173px "New C-Cl bond" / "C-H bond" caption
// steals. Boxes keep NEAR_RADIUS because the enclosure guard already pins
// them to a real frame.
export const POINT_GLUE_RADIUS = 120;

// Anchor-snap catches the tags near-snap CAN'T: label-less points/boxes and
// labels whose element is far away. When such a tag's guess sits within this
// distance of a real scene frame's center, it is glued to that frame — the
// frame IS the pixel-perfect answer (real UIA/OCR bounds), so this saves the
// slow second-pass LLM re-read for exactly the tags that used to need it most
// (CapCut icons, toolbar buttons, label-less tours).
export const ANCHOR_RADIUS = 180;

// Containers wrap content but describe no actionable surface (the same set
// scene.ts's CONTAINER_TYPES uses for click-target resolution). A container
// frame must never swallow a tag's anchor.
const CONTAINER_TYPES = new Set([
  'Window',
  'Frame',
  'Pane',
  'Document',
  'Group',
  'TitleBar',
  'MenuBar',
]);

// Deterministic fallback snap: glue an UN-labeled (or far-labeled) tag to the
// NEAREST scene element frame when that frame is close enough. This is the
// pass that makes the common UI case instant — a `[POINT:1000,760]` aimed at a
// toolbar icon lands on the icon's REAL UIA frame with no LLM re-read at all.
// Rules, kept conservative:
//  - POINT/ARROW-head: nearest element center within ANCHOR_RADIUS.
//  - BOX: the element whose center is INSIDE the drawn box (shrink-to-fit — the
//    "AI draws whole-toolbar boxes" bug dies here, not in a prompt), and the
//    element must not be a container or a merged caption row.
// Both produce the same screen-* geometry and (hint → true) calibration pair as
// a name snap, so the group-shift math treats them identically.
export function anchorSnap(
  tag: AnnotationTag,
  scene: SceneElement[] | null,
  geo: PointGeo | null,
): NearSnap | null {
  if (!usableGeo(geo) || !scene || scene.length === 0) return null;
  if (tag.kind === 'box-el') return null;
  const h = targetPixel(tag);
  if (!h) return null;
  const imageEls = scene.map((el) => toImageElement(el, geo));

  let best: { el: SceneElement; d2: number } | null = null;
  if (tag.kind === 'box') {
    // Only a real (non-row, non-container) element whose center is inside the
    // drawn box counts — the box gets glued DOWN to its true frame.
    for (const el of imageEls) {
      if (CONTAINER_TYPES.has(el.type) || rowLike(el)) continue;
      const c = centerOf(el);
      if (c.x < tag.x || c.x > tag.x + tag.w || c.y < tag.y || c.y > tag.y + tag.h) continue;
      const dx = c.x - h.x;
      const dy = c.y - h.y;
      const d2 = dx * dx + dy * dy;
      if (!best || d2 < best.d2) best = { el, d2 };
    }
  } else {
    for (const el of imageEls) {
      if (CONTAINER_TYPES.has(el.type)) continue;
      const c = centerOf(el);
      const dx = c.x - h.x;
      const dy = c.y - h.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= ANCHOR_RADIUS * ANCHOR_RADIUS && (!best || d2 < best.d2)) best = { el, d2 };
    }
  }
  if (!best) return null;
  const orig = scene.find((s) => s.id === best.el.id) ?? best.el;
  const geom: ResolvedGeom =
    tag.kind === 'box'
      ? {
          kind: 'screen-box',
          x: Math.round(agentToDip(geo, orig.bounds[0])),
          y: Math.round(agentToDip(geo, orig.bounds[1])),
          w: Math.round(agentToDip(geo, orig.bounds[2]) - agentToDip(geo, orig.bounds[0])),
          h: Math.round(agentToDip(geo, orig.bounds[3]) - agentToDip(geo, orig.bounds[1])),
        }
      : {
          kind: 'screen-point',
          x: Math.round(agentToDip(geo, orig.center[0])),
          y: Math.round(agentToDip(geo, orig.center[1])),
        };
  const pair: CalibPair = { hx: h.x, hy: h.y, tx: best.el.center[0], ty: best.el.center[1], w: 1 };
  return { el: orig, geom, pair };
}

function centerOf(el: SceneElement): { x: number; y: number } {
  const c = el.center;
  return {
    x: typeof c?.[0] === 'number' ? c[0] : Math.round((el.bounds[0] + el.bounds[2]) / 2),
    y: typeof c?.[1] === 'number' ? c[1] : Math.round((el.bounds[1] + el.bounds[3]) / 2),
  };
}

// Where the tag ended up after resolution. `screen-*` geometries are REAL
// element bounds (screen DIP) — emit uses them verbatim, no mapping, no DX/DY
// nudge. `image-*` geometries are pixel-space results (hint, refined, or
// group-shifted) — emit maps them through the geo and applies the manual
// nudge, but NEVER re-snaps them (the resolver already made that call).
export type ResolvedGeom =
  | { kind: 'screen-point'; x: number; y: number }
  | { kind: 'screen-box'; x: number; y: number; w: number; h: number }
  | { kind: 'screen-arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'image-point'; x: number; y: number }
  | { kind: 'image-box'; x: number; y: number; w: number; h: number }
  | { kind: 'image-arrow'; x1: number; y1: number; x2: number; y2: number };

// One (hint -> true) correspondence used to measure the group's shift.
// Everything is in the tag's IMAGE pixel space so the fitted transform applies
// directly to un-resolved image tags.
export type CalibPair = { hx: number; hy: number; tx: number; ty: number; w: number };

// Similarity transform (scale + translation) mapping a guessed image point to
// the true location: true = s*guess + (tx,ty). s=1 with |t|>0 is a pure shift.
export type Affine = { s: number; tx: number; ty: number };

// Coordinate helpers (screen DIP <-> tag image px). For a whole-display shot
// at 100% these are the identity; for downscaled shots or region crops they
// invert exactly the mapPointToScreen formula.

function usableGeo(geo: PointGeo | null): geo is PointGeo {
  return !!geo && geo.imgW > 0 && geo.imgH > 0 && geo.winW > 0 && geo.winH > 0;
}

// Scene "agent" coordinates are native physical pixels on Windows (the UIA /
// OCR / GetWindowRect space) but Electron DIP on macOS. The geo's image grid
// maps DIP↔px, so an agent coordinate must first be brought into DIP space by
// the per-display scale factor. agentUnitsPerDip defaults to 1 (macOS / 100%
// Windows), where the division is the identity.
export function agentToDip(geo: PointGeo, v: number): number {
  const sf = geo.agentUnitsPerDip ?? 1;
  return sf > 0 ? v / sf : v;
}

export function toImageX(geo: PointGeo, sx: number): number {
  if (geo.winW <= 0 || geo.imgW <= 0) return Math.round(sx);
  const kx = regionCropScale(geo).sx;
  if (kx <= 0) return Math.round(sx);
  return Math.round((((sx - geo.absLeft) / geo.winW) * geo.imgW - (geo.region?.x ?? 0)) / kx);
}

export function toImageY(geo: PointGeo, sy: number): number {
  if (geo.winH <= 0 || geo.imgH <= 0) return Math.round(sy);
  const ky = regionCropScale(geo).sy;
  if (ky <= 0) return Math.round(sy);
  return Math.round((((sy - geo.absTop) / geo.winH) * geo.imgH - (geo.region?.y ?? 0)) / ky);
}

function toImageElement(el: SceneElement, geo: PointGeo): SceneElement {
  const b1 = toImageX(geo, agentToDip(geo, el.bounds[0]));
  const b2 = toImageY(geo, agentToDip(geo, el.bounds[1]));
  const b3 = toImageX(geo, agentToDip(geo, el.bounds[2]));
  const b4 = toImageY(geo, agentToDip(geo, el.bounds[3]));
  return {
    ...el,
    bounds: [b1, b2, b3, b4],
    center: [
      typeof el.center?.[0] === 'number'
        ? toImageX(geo, agentToDip(geo, el.center[0]))
        : Math.round((b1 + b3) / 2),
      typeof el.center?.[1] === 'number'
        ? toImageY(geo, agentToDip(geo, el.center[1]))
        : Math.round((b2 + b4) / 2),
    ],
  };
}

export function targetPixel(t: AnnotationTag): { x: number; y: number } | null {
  switch (t.kind) {
    case 'point':
      return { x: t.x, y: t.y };
    case 'box':
      return { x: Math.round(t.x + t.w / 2), y: Math.round(t.y + t.h / 2) };
    case 'arrow':
      return { x: t.x2, y: t.y2 };
    case 'box-el':
      return null;
  }
}

export function imageGeomOf(t: AnnotationTag): ResolvedGeom | null {
  switch (t.kind) {
    case 'point':
      return { kind: 'image-point', x: t.x, y: t.y };
    case 'box':
      return { kind: 'image-box', x: t.x, y: t.y, w: t.w, h: t.h };
    case 'arrow':
      return { kind: 'image-arrow', x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2 };
    case 'box-el':
      return null;
  }
}

// Resolution

// nearSnap now returns calibration pair for ANY name match, but geom (snap)
// only when the element is near the guess. This lets far matches (captions
// across the screen) contribute to the group-shift calibration without
// hijacking the chip's position.
export type NearSnap = { el: SceneElement; geom: ResolvedGeom | null; pair: CalibPair };

// Glue a tag to the real element its label names, only when that element sits
// near the guess. The element frame is returned in SCREEN DIP (its natural
// space, bypassing geo mapping at emit); the calibration pair is in IMAGE px.
// Returns {geom: null, pair} for far matches (calibration only, no snap).
export function nearSnap(
  tag: AnnotationTag,
  scene: SceneElement[] | null,
  geo: PointGeo | null,
  usedIds?: Set<string>,
): NearSnap | null {
  if (!usableGeo(geo) || !scene || scene.length === 0) return null;
  if (tag.kind === 'box-el' || tag.kind === 'arrow') return null;
  const h = targetPixel(tag);
  if (!h) return null;
  const imageEls = scene.map((el) => toImageElement(el, geo));
  const boxFrame =
    tag.kind === 'box' ? { x: tag.x, y: tag.y, w: tag.w, h: tag.h } : undefined;
  const matched = matchElementByLabel(tag.label, imageEls, h.x, h.y, boxFrame, usedIds);
  if (!matched) return null;
  // BOX enclosure guard: only glue a drawn box to the matched element when
  // that element's frame is basically enclosed by the drawn box (dilated 50%).
  // A tiny 250x100 box must never snap onto a giant 1094x660 element (2/3 of
  // the screen) that merely shares a name — that was the "Chlorobenzene box
  // glued to a whole window" misfire. Small tight icons/buttons easily fit.
  if (tag.kind === 'box') {
    const eb = matched.bounds;
    const dw = tag.w * 0.5;
    const dh = tag.h * 0.5;
    const boxLeft = tag.x - dw;
    const boxTop = tag.y - dh;
    const boxRight = tag.x + tag.w + dw;
    const boxBottom = tag.y + tag.h + dh;
    const enclosed =
      eb[0] >= boxLeft &&
      eb[2] <= boxRight &&
      eb[1] >= boxTop &&
      eb[3] <= boxBottom;
    if (!enclosed) return null;
  }
  const dx = matched.center[0] - h.x;
  const dy = matched.center[1] - h.y;
  const withinNear = dx * dx + dy * dy <= NEAR_RADIUS * NEAR_RADIUS;
  // Resolution-phase glue: for a point, the guess must be essentially ON the
  // matched frame (inside it, dilated by its own size) or very close to its
  // center. Otherwise the match is treated as caption-only: calibration pair
  // still recorded, position left in image space. Boxes keep the plain
  // NEAR_RADIUS check (their enclosure guard is the real gate).
  let isNear = withinNear;
  if (tag.kind === 'point') {
    const bw = Math.max(1, matched.bounds[2] - matched.bounds[0]);
    const bh = Math.max(1, matched.bounds[3] - matched.bounds[1]);
    const onFrame =
      h.x >= matched.bounds[0] - bw * 0.5 &&
      h.x <= matched.bounds[2] + bw * 0.5 &&
      h.y >= matched.bounds[1] - bh * 0.5 &&
      h.y <= matched.bounds[3] + bh * 0.5;
    isNear = withinNear && (onFrame || dx * dx + dy * dy <= POINT_GLUE_RADIUS * POINT_GLUE_RADIUS);
  }
  const orig = scene.find((s) => s.id === matched.id) ?? matched;
  const pair: CalibPair = { hx: h.x, hy: h.y, tx: matched.center[0], ty: matched.center[1], w: 1 };
  if (!isNear) return { el: orig, geom: null, pair };
  const geom: ResolvedGeom =
    tag.kind === 'point'
      ? {
          kind: 'screen-point',
          x: Math.round(agentToDip(geo, typeof orig.center?.[0] === 'number' ? orig.center[0] : (orig.bounds[0] + orig.bounds[2]) / 2)),
          y: Math.round(agentToDip(geo, typeof orig.center?.[1] === 'number' ? orig.center[1] : (orig.bounds[1] + orig.bounds[3]) / 2)),
        }
      : {
          kind: 'screen-box',
          x: Math.round(agentToDip(geo, orig.bounds[0])),
          y: Math.round(agentToDip(geo, orig.bounds[1])),
          w: Math.round(agentToDip(geo, orig.bounds[2]) - agentToDip(geo, orig.bounds[0])),
          h: Math.round(agentToDip(geo, orig.bounds[3]) - agentToDip(geo, orig.bounds[1])),
        };
  return { el: orig, geom, pair };
}

// Nearest real content anchor to a tag's guess (image px), used as the round-2
// re-aim center when the first zoom crop missed. Box tags skip wide OCR-row
// frames (a structure chip should not re-aim at a caption line).
export function nearestContentCenter(
  tag: AnnotationTag,
  scene: SceneElement[] | null,
  geo: PointGeo | null,
  opts: { radius?: number } = {},
): { x: number; y: number } | null {
  if (!usableGeo(geo) || !scene || scene.length === 0) return null;
  const t = targetPixel(tag);
  if (!t) return null;
  const radius = opts.radius ?? 400;
  let best: { x: number; y: number; d2: number } | null = null;
  for (const el of scene) {
    if (tag.kind === 'box' && rowLike(el)) continue;
    const cx = toImageX(geo, agentToDip(geo, el.center[0]));
    const cy = toImageY(geo, agentToDip(geo, el.center[1]));
    const dx = cx - t.x;
    const dy = cy - t.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= radius * radius && (!best || d2 < best.d2)) best = { x: cx, y: cy, d2 };
  }
  return best ? { x: best.x, y: best.y } : null;
}

// Group calibration (the "whole group sits left" fix)

// Weighted least-squares fit of a similarity transform (s, tx, ty) mapping
// hint -> true. A single pair degrades to the pure displacement.
export function fitCalibration(pairs: CalibPair[]): Affine | null {
  if (pairs.length === 0) return null;
  let s0 = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxtx = 0;
  let syty = 0;
  let ttx = 0;
  let tty = 0;
  for (const p of pairs) {
    const w = p.w;
    s0 += w;
    sx += w * p.hx;
    sy += w * p.hy;
    sxx += w * p.hx * p.hx;
    syy += w * p.hy * p.hy;
    sxtx += w * p.hx * p.tx;
    syty += w * p.hy * p.ty;
    ttx += w * p.tx;
    tty += w * p.ty;
  }
  if (s0 <= 0) return null;
  if (pairs.length === 1) {
    const p = pairs[0];
    return { s: 1, tx: p.tx - p.hx, ty: p.ty - p.hy };
  }
  const denom = (sxx + syy) * s0 - sx * sx - sy * sy;
  if (Math.abs(denom) < 1e-9) return null;
  const s = ((sxtx + syty) * s0 - sx * ttx - sy * tty) / denom;
  const tx = (ttx - s * sx) / s0;
  const ty = (tty - s * sy) / s0;
  if (!Number.isFinite(s) || !Number.isFinite(tx) || !Number.isFinite(ty)) return null;
  return { s, tx, ty };
}

// Robust group-shift measurement: compute BOTH pure translation and similarity,
// then pick the simpler model (translation) when it fits nearly as well.
// This matches the observed "whole group sits left" pattern — a global offset,
// not a scale distortion.
// Optimization: if there are ≥2 refine pairs (w=0.6) whose per-pair shifts
// agree within 2px (MAD ≤ 2), use their median directly — avoids affine noise from
// mixing snap+refine pairs with different error profiles.
export function fitGroupShift(
  pairs: CalibPair[],
  opts: { maxSize?: number } = {},
): Affine | null {
  if (pairs.length === 0) return null;

  // Separate refine pairs (weight 0.6) from snap pairs (weight 1.0)
  const refinePairs = pairs.filter((p) => p.w < 1);
  const snapPairs = pairs.filter((p) => p.w >= 1);

  // Optimization: if multiple refine pairs agree tightly, use their median shift.
  // Refine pairs measure the SAME target (the model's own guess vs re-read),
  // so they share the exact same noise profile. When they agree, it's a
  // high-confidence direct measurement of the global shift.
  if (refinePairs.length >= 2) {
    const refineDx = refinePairs.map((p) => p.tx - p.hx);
    const refineDy = refinePairs.map((p) => p.ty - p.hy);
    const medDx = median(refineDx);
    const medDy = median(refineDy);
    const madX = median(refineDx.map((d) => Math.abs(d - medDx)));
    const madY = median(refineDy.map((d) => Math.abs(d - medDy)));
    // If median absolute deviation ≤ 2px, the refine pairs are consistent
    if (madX <= 2 && madY <= 2) {
      const translation: Affine = { s: 1, tx: medDx, ty: medDy };
      const maxSize = opts.maxSize ?? 4000;
      if (Math.abs(translation.tx) > maxSize * 0.4 || Math.abs(translation.ty) > maxSize * 0.4) return null;
      return translation;
    }
  }

  // Fallback: general translation+similarity fit on all pairs
  let pr = pairs;
  const mx = median(pr.map((p) => p.tx - p.hx));
  const my = median(pr.map((p) => p.ty - p.hy));
  const translation: Affine = { s: 1, tx: mx, ty: my };

  if (pr.length === 1) {
    const maxSize = opts.maxSize ?? 4000;
    if (Math.abs(translation.tx) > maxSize * 0.4 || Math.abs(translation.ty) > maxSize * 0.4) return null;
    return translation;
  }

  // Consistency gate (computed up front so every translation-look-alike path
  // honors it): a GLOBAL shift is only trustworthy when the pairs agree on it.
  // On a multi-spot diagram (several molecules, caption-text columns), per-spot
  // errors point every direction and their median average looks like a "shift"
  // that would drag still-unplaced tags off their real targets — observed:
  // tx=87 ty=-258 on an 8-pair chemistry run yanked good points into
  // off-molecule corners. The tight-refine shortcut above keeps its own 2px
  // standard.
  const transResiduals = pr.map((p) => Math.hypot(p.tx - p.hx - mx, p.ty - p.hy - my));
  const consistencyPasses = median(transResiduals) <= Math.max(24, Math.hypot(mx, my) * 0.4);

  let simPr = pr;
  if (simPr.length >= 3) {
    const residuals = simPr.map((p) =>
      Math.hypot(p.tx - p.hx - mx, p.ty - p.hy - my),
    );
    const medR = median(residuals);
    const kept = simPr.filter((p, i) => residuals[i] <= Math.max(120, medR * 2.5));
    // If more than 30% of pairs were trimmed, data is too noisy for a
    // similarity fit — fall through to pure translation instead.
    if (kept.length >= 2 && kept.length >= simPr.length * 0.7) simPr = kept;
    else simPr = pr;
  }
  const similarity = fitCalibration(simPr);
  if (!similarity) return consistencyPasses ? translation : null;
  // Scale sanity cap: a similarity transform with |s-1| > 0.15 is almost
  // certainly fitting noise, not a real provider resize. Force translation.
  if (Math.abs(similarity.s - 1) > 0.15) return consistencyPasses ? translation : null;

  const simResiduals = pr.map((p) => {
    const dx = similarity.s * p.hx + similarity.tx - p.tx;
    const dy = similarity.s * p.hy + similarity.ty - p.ty;
    return Math.hypot(dx, dy);
  });
  const medTrans = median(transResiduals);
  const medSim = median(simResiduals);

  // Prefer translation if its median residual is within 15% of similarity's.
  // This lets a true downscale (near-zero sim residuals) win, while a noisy
  // cloud with scale ≈ 1.9 but worse fit falls back to pure translation.
  const useTranslation = medTrans <= medSim * 1.15;
  const chosen = useTranslation ? translation : similarity;

  // A similarity that settled back onto a pure translation still answers to
  // the consistency gate.
  if (Math.abs(chosen.s - 1) <= 0.05 && !consistencyPasses) return null;

  const maxSize = opts.maxSize ?? 4000;
  if (Math.abs(chosen.tx) > maxSize * 0.4 || Math.abs(chosen.ty) > maxSize * 0.4) return null;
  return chosen;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function applyAffine(x: number, y: number, a: Affine): [number, number] {
  return [Math.round(a.s * x + a.tx), Math.round(a.s * y + a.ty)];
}

export function shiftTag(t: AnnotationTag, a: Affine): AnnotationTag {
  switch (t.kind) {
    case 'point': {
      const [x, y] = applyAffine(t.x, t.y, a);
      return { ...t, x, y };
    }
    case 'box': {
      const [x, y] = applyAffine(t.x, t.y, a);
      const [x2, y2] = applyAffine(t.x + t.w, t.y + t.h, a);
      return { ...t, x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
    }
    case 'arrow': {
      const [x1, y1] = applyAffine(t.x1, t.y1, a);
      const [x2, y2] = applyAffine(t.x2, t.y2, a);
      return { ...t, x1, y1, x2, y2 };
    }
    case 'box-el':
      return t;
  }
}