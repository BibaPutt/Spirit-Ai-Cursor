import { describe, expect, it } from 'vitest';
import {
  applyRefineResults,
  parseRefineReply,
  planRefineCrops,
  type RefineCropSpec,
} from '../electron/llm/zoom-refine';
import type { AnnotationTag } from '../electron/llm/point';
import type { SceneElement } from '../electron/capture/scene';

const IMG = { imgW: 1280, imgH: 720 };

function el(name: string, x: number, y: number): SceneElement {
  return {
    id: `t-${name}`,
    type: 'Button',
    name,
    bounds: [x - 20, y - 10, x + 20, y + 10],
    center: [x, y],
    enabled: true,
    clickable: true,
    source: 'uia',
  };
}

describe('planRefineCrops', () => {
  it('plans a focused, in-bounds crop for an un-snapped point', () => {
    const tags: AnnotationTag[] = [{ kind: 'point', x: 500, y: 300, label: 'benzene ring', screen: 0 }];
    const specs = planRefineCrops(tags, IMG.imgW, IMG.imgH, null);
    expect(specs).toHaveLength(1);
    const s = specs[0];
    expect(s.tagIndex).toBe(0);
    expect(s.crop.x).toBeGreaterThanOrEqual(0);
    expect(s.crop.x + s.crop.w).toBeLessThanOrEqual(IMG.imgW);
    // the estimate is inside the crop
    expect(s.crop.x).toBeLessThanOrEqual(s.cx);
    expect(s.crop.x + s.crop.w).toBeGreaterThanOrEqual(s.cx);
    expect(s.scale).toBeGreaterThanOrEqual(1);
    expect(s.outW).toBe(s.crop.w * s.scale);
    expect(s.outH).toBe(s.crop.h * s.scale);
  });

  it('skips tags that snap to a real scene element (element wins)', () => {
    const tags: AnnotationTag[] = [
      { kind: 'point', x: 500, y: 300, label: 'Play button', screen: 0 },
    ];
    const specs = planRefineCrops(tags, IMG.imgW, IMG.imgH, [el('Play button', 500, 300)]);
    expect(specs).toHaveLength(0);
  });

  it('skips box-el and wildly out-of-bounds points (nothing to refine against)', () => {
    const tags: AnnotationTag[] = [
      { kind: 'box-el', id: 'el12ab', label: 'Layer panel' },
      { kind: 'point', x: 99999, y: 300, label: 'off screen', screen: 0 },
    ];
    expect(planRefineCrops(tags, IMG.imgW, IMG.imgH, null)).toHaveLength(0);
  });

  it('refines a slightly-OOB estimate by clamping its center onto the image (bottom-edge recovery)', () => {
    // The provider wrote "Broken Bond" at y=886 in an 819-tall image (the exact
    // log case). A few percent past the edge means a real target at the bottom
    // — clamp and re-read rather than DROP the tag.
    const tags: AnnotationTag[] = [{ kind: 'point', x: 554, y: 886, label: 'Broken Bond', screen: 0 }];
    const specs = planRefineCrops(tags, 1456, 819, null);
    expect(specs).toHaveLength(1);
    const s = specs[0];
    expect(s.cx).toBe(554);
    expect(s.cy).toBe(818); // clamped to the last image row
    expect(s.crop.x + s.crop.w).toBeLessThanOrEqual(1456);
    expect(s.crop.y + s.crop.h).toBeLessThanOrEqual(819);
  });

  it('does not refine a point too far outside the image (genuine drop case)', () => {
    const tags: AnnotationTag[] = [{ kind: 'point', x: 1000, y: 5000, label: 'nowhere', screen: 0 }];
    expect(planRefineCrops(tags, IMG.imgW, IMG.imgH, null)).toHaveLength(0);
  });

  it('centers a box crop on the box and sizes it from the box footprint', () => {
    const tags: AnnotationTag[] = [
      { kind: 'box', x: 200, y: 100, w: 60, h: 40, label: 'muscle', screen: 0 },
    ];
    const specs = planRefineCrops(tags, IMG.imgW, IMG.imgH, null);
    expect(specs).toHaveLength(1);
    const s = specs[0];
    expect(s.model).toBe('box');
    expect(s.cx).toBe(230); // box center
    expect(s.cy).toBe(120);
    expect(s.crop.w).toBeGreaterThanOrEqual(60);
    expect(s.crop.h).toBeGreaterThanOrEqual(40);
  });

  it('sizes a large-box crop to CONTAIN the whole box (royal-size fix)', () => {
    // The log case: an 801px-wide box. Its w/h may live in a WRONG scaled
    // space (provider-resized / physical px), so the crop must contain every
    // pixel of the enclosed region for the second pass to MEASURE the bounds.
    // boxCropMax 1024 > 801 guarantees the whole box fits (the old 480 cap
    // truncated it, losing the size we were trying to recover).
    const tags: AnnotationTag[] = [
      { kind: 'box', x: 40, y: 477, w: 801, h: 200, label: 'cycloalkene', screen: 0 },
    ];
    const specs = planRefineCrops(tags, 1456, 819, null);
    expect(specs).toHaveLength(1);
    const s = specs[0];
    expect(s.crop.w).toBeGreaterThanOrEqual(801);
    expect(s.crop.h).toBeGreaterThanOrEqual(200);
    // the whole box is inside the crop
    expect(s.crop.x).toBeLessThanOrEqual(40);
    expect(s.crop.y).toBeLessThanOrEqual(477);
    expect(s.crop.x + s.crop.w).toBeGreaterThanOrEqual(841);
    expect(s.crop.y + s.crop.h).toBeGreaterThanOrEqual(677);
    // clamped inside the image
    expect(s.crop.x + s.crop.w).toBeLessThanOrEqual(1456);
    expect(s.crop.y + s.crop.h).toBeLessThanOrEqual(819);
  });

  it('clamps a crop near an edge instead of going out of bounds', () => {
    const tags: AnnotationTag[] = [{ kind: 'point', x: 2, y: 2, label: 'corner dot', screen: 0 }];
    const specs = planRefineCrops(tags, IMG.imgW, IMG.imgH, null);
    expect(specs).toHaveLength(1);
    expect(specs[0].crop.x).toBe(0);
    expect(specs[0].crop.y).toBe(0);
    expect(specs[0].crop.x + specs[0].crop.w).toBeLessThanOrEqual(IMG.imgW);
  });

  it('respects the max cap and preserves tag order', () => {
    const tags: AnnotationTag[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'point' as const,
      x: 100 + i * 10,
      y: 100,
      label: `t${i}`,
      screen: 0,
    }));
    const specs = planRefineCrops(tags, IMG.imgW, IMG.imgH, null, { max: 3 });
    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.tagIndex)).toEqual([0, 1, 2]);
  });

  it('returns [] for a degenerate image size', () => {
    const tags: AnnotationTag[] = [{ kind: 'point', x: 10, y: 10, label: 'x', screen: 0 }];
    expect(planRefineCrops(tags, 0, 0, null)).toEqual([]);
  });
});

describe('parseRefineReply', () => {
it('parses a bare `x,y` line', () => {
    expect(parseRefineReply('142,88')).toEqual({ x: 142, y: 88 });
    expect(parseRefineReply('  12  34\n')).toEqual({ x: 12, y: 34 });
  });

  it('parses a bare `x,y,w,h` box-bounds line', () => {
    expect(parseRefineReply('120,340,300,60')).toEqual({ x: 120, y: 340, w: 300, h: 60 });
    expect(parseRefineReply(' 0,0,1024,779\n')).toEqual({ x: 0, y: 0, w: 1024, h: 779 });
  });

  it('parses `x,y,w,h` box bounds out of prose replies too', () => {
    // The box-bounds version of the favorite prose form: "it spans from
    // (120, 340) to (120+300, 340+60)" — the FIRST four-integer run wins.
    expect(parseRefineReply('the box spans 120,340,300,60 px')).toEqual({ x: 120, y: 340, w: 300, h: 60 });
    // A 3-integer run is unsupported (not a box) — falls back to the point pair.
    expect(parseRefineReply('about 120,340,300 I think')).toEqual({ x: 120, y: 340 });
  });

  it('recovers a coordinate pair from prose replies', () => {
    // Real small models (e.g. the free tier) almost never reply with the bare
    // `x,y` line; prose like "the center is around (142, 88)" is the norm.
    // Rejecting it made every real run report `0/8 re-aimed`. Take the FIRST
    // two-integer pair, but still reject explicit misses. The pair must be
    // separated by punctuation/whitespace only — words ("or") don't count.
    expect(parseRefineReply('the center is around (142, 88) I think')).toEqual({ x: 142, y: 88 });
    expect(parseRefineReply('its at 142,88 pixels.')).toEqual({ x: 142, y: 88 });
    expect(parseRefineReply('roughly 140 or 150, maybe')).toBeNull();
    expect(parseRefineReply('x = 7; y = 9')).toBeNull();
    expect(parseRefineReply('none — the target is not in this crop')).toBeNull();
  });

  it('rejects prose, single numbers and nothing', () => {
    expect(parseRefineReply('')).toBeNull();
    expect(parseRefineReply('the target is around the middle')).toBeNull();
    expect(parseRefineReply('42')).toBeNull();
  });

  it('accepts explicit misses as null', () => {
    expect(parseRefineReply('none')).toBeNull();
    expect(parseRefineReply('n/a — not visible in crop')).toBeNull();
    expect(parseRefineReply('Nope')).toBeNull();
  });
});

describe('applyRefineResults', () => {
  const spec: RefineCropSpec = {
    tagIndex: 0,
    label: 'ring',
    model: 'point',
    cx: 300,
    cy: 200,
    crop: { x: 240, y: 140, w: 120, h: 120 },
    scale: 3,
    outW: 360,
    outH: 360,
  };

  it('maps an upscaled-crop point back into image pixels', () => {
    const tags: AnnotationTag[] = [{ kind: 'point', x: 300, y: 200, label: 'ring', screen: 0 }];
    // crop-local 70,50 at 3x → image 240+23.3,140+16.7 → (263,157)
    const out = applyRefineResults(
      tags,
      [{ spec, result: { x: 70, y: 50 } }],
      IMG.imgW,
      IMG.imgH,
    );
    expect(out[0]).toMatchObject({ kind: 'point', x: 263, y: 157, label: 'ring' });
  });

  it('uses MEASURED box bounds from a 4-int refine reply (authoritative w/h)', () => {
    // The box's tag w/h may live in a WRONG scaled space (provider-resized /
    // physical px) — the exact "zoomed box is the right spot but the wrong
    // size" case. When the second pass returns x,y,w,h, the bounds are
    // AUTHORITATIVE and replace the tag's size, not just re-center it.
    const tags: AnnotationTag[] = [
      { kind: 'box', x: 40, y: 477, w: 801, h: 200, label: 'cycloalkene', screen: 0 },
    ];
    // 1456x819 image, crop = (0,65,1024,754) from the plan. The model measures
    // the true ENCLOSED region (top-left at image (40,477), 607px wide) and
    // replies in payload px at 1x: (40,412,607,152).
    const specB: RefineCropSpec = {
      tagIndex: 0,
      label: 'cycloalkene',
      model: 'box',
      cx: 440,
      cy: 577,
      crop: { x: 0, y: 65, w: 1024, h: 754 },
      scale: 1,
      outW: 1024,
      outH: 754,
    };
    const out = applyRefineResults(
      tags,
      [{ spec: specB, result: { x: 40, y: 412, w: 607, h: 152 } }],
      1456,
      819,
    );
    expect(out[0]).toMatchObject({ kind: 'box', x: 40, y: 477, w: 607, h: 152 });
  });

  it('clamps measured box bounds inside the image', () => {
    const tags: AnnotationTag[] = [
      { kind: 'box', x: 300, y: 200, w: 40, h: 20, label: 'edge box', screen: 0 },
    ];
    const specB: RefineCropSpec = { ...spec, model: 'box', crop: { x: 0, y: 0, w: 120, h: 120 } };
    // measured top-left at the very crop corner stays (0,0) in the image
    const out = applyRefineResults(
      tags,
      [{ spec: specB, result: { x: 0, y: 0, w: 120, h: 120 } }],
      IMG.imgW,
      IMG.imgH,
    );
    expect(out[0]).toMatchObject({ kind: 'box', x: 0, y: 0, w: 40, h: 40 });
  });

  it('re-centers a box on the refined point, clamped inside the image', () => {
    const tags: AnnotationTag[] = [
      { kind: 'box', x: 256, y: 156, w: 40, h: 20, label: 'boxed', screen: 0 },
    ];
    const specB: RefineCropSpec = { ...spec, model: 'box', cx: 300, cy: 200 };
    // crop-local 180,180 at 3x → image center (300,200) → box top-left (280,190)
    const stay = applyRefineResults(tags, [{ spec: specB, result: { x: 180, y: 180 } }], IMG.imgW, IMG.imgH);
    expect(stay[0]).toMatchObject({ kind: 'box', x: 280, y: 190, w: 40, h: 20 });
    // result at the very crop corner near the image edge clamps top-left to 0,0
    const cornerSpec: RefineCropSpec = { ...specB, crop: { x: 0, y: 0, w: 120, h: 120 } };
    const clamp = applyRefineResults(
      tags,
      [{ spec: cornerSpec, result: { x: 0, y: 0 } }],
      IMG.imgW,
      IMG.imgH,
    );
    expect(clamp[0].x).toBe(0);
    expect(clamp[0].y).toBe(0);
  });

  it('refines the arrow head and leaves the tail untouched', () => {
    const tags: AnnotationTag[] = [
      { kind: 'arrow', x1: 100, y1: 100, x2: 320, y2: 220, label: 'new bond', screen: 0 },
    ];
    const specA: RefineCropSpec = { ...spec, model: 'arrow-head', cx: 320, cy: 220 };
    const out = applyRefineResults(
      tags,
      [{ spec: specA, result: { x: 90, y: 90 } }],
      IMG.imgW,
      IMG.imgH,
    );
    expect(out[0]).toMatchObject({ x1: 100, y1: 100, x2: 270, y2: 170 });
  });

  it('leaves tags with a null result untouched and box-el alone', () => {
    const tags: AnnotationTag[] = [
      { kind: 'point', x: 5, y: 5, label: 'miss', screen: 0 },
      { kind: 'box-el', id: 'el9', label: 'Panel' },
    ];
    const out = applyRefineResults(tags, [{ spec, result: null }], IMG.imgW, IMG.imgH);
    expect(out[0]).toMatchObject({ x: 5, y: 5 });
    expect(out[1]).toMatchObject({ kind: 'box-el', id: 'el9' });
  });

  it('maps a native-payload result via pxPerImage when provided', () => {
    // A NATIVE crop of the same screen carries more pixels per image pixel
    // (say 2.4x) than the 3x upsampled downscaled crop. The outcome declares
    // pxPerImage and applyRefineResults must divide by IT, not the spec scale.
    const tags: AnnotationTag[] = [{ kind: 'point', x: 300, y: 200, label: 'ring', screen: 0 }];
    const out = applyRefineResults(
      tags,
      [{ spec, result: { x: 168, y: 120 }, pxPerImage: 2.4 }],
      IMG.imgW,
      IMG.imgH,
    );
    // 240 + 168/2.4 = 310 ; 140 + 120/2.4 = 190
    expect(out[0]).toMatchObject({ kind: 'point', x: 310, y: 190 });
  });

  it('falls back to spec.scale when pxPerImage is absent (upsampled crop)', () => {
    // Regression guard: outcomes without pxPerImage must keep the old 3x math.
    const tags: AnnotationTag[] = [{ kind: 'point', x: 300, y: 200, label: 'ring', screen: 0 }];
    const out = applyRefineResults(
      tags,
      [{ spec, result: { x: 70, y: 50 } }],
      IMG.imgW,
      IMG.imgH,
    );
    expect(out[0]).toMatchObject({ kind: 'point', x: 263, y: 157 });
  });
});