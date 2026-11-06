import { describe, expect, it } from 'vitest';
import {
  anchorSnap,
  fitGroupShift,
  imageGeomOf,
  nearSnap,
  nearestContentCenter,
  shiftTag,
  toImageX,
  toImageY,
  type Affine,
} from '../electron/llm/annotation-resolver';
import type { AnnotationTag, PointGeo } from '../electron/llm/point';
import type { SceneElement } from '../electron/capture/scene';

function el(id: string, name: string, bounds: [number, number, number, number]): SceneElement {
  return {
    id,
    type: 'button',
    name,
    bounds,
    center: [
      Math.round((bounds[0] + bounds[2]) / 2),
      Math.round((bounds[1] + bounds[3]) / 2),
    ],
    enabled: true,
    clickable: true,
    source: 'uia',
  };
}

// Whole-display 1920x1080 at 100% DPI — the observed identity case.
const GEO: PointGeo = { imgW: 1920, imgH: 1080, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };

function point(x: number, y: number, label: string): AnnotationTag {
  return { kind: 'point', x, y, label, screen: 0 };
}
function box(x: number, y: number, w: number, h: number, label: string): AnnotationTag {
  return { kind: 'box', x, y, w, h, label, screen: 0 };
}
function arrow(x1: number, y1: number, x2: number, y2: number, label: string): AnnotationTag {
  return { kind: 'arrow', x1, y1, x2, y2, label, screen: 0 };
}

describe('toImageX / toImageY', () => {
  it('is the identity for a whole-display shot (image px == screen DIP)', () => {
    expect(toImageX(GEO, 1227)).toBe(1227);
    expect(toImageY(GEO, 375)).toBe(375);
  });

  it('inverts the downscaled-image mapping (screen -> image)', () => {
    const geo = { imgW: 1280, imgH: 720, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };
    expect(toImageX(geo, 1920)).toBe(1280);
    expect(toImageX(geo, 960)).toBe(640);
    expect(toImageY(geo, 1080)).toBe(720);
  });

  it('inverts a region crop offset', () => {
    const geo = { imgW: 1920, imgH: 1080, absLeft: 0, absTop: 0, winW: 1920, winH: 1080, region: { x: 100, y: 50, w: 400, h: 300 } };
    expect(toImageX(geo, 100)).toBe(0);
    expect(toImageX(geo, 500)).toBe(400);
    expect(toImageY(geo, 50)).toBe(0);
  });

  it('inverts a region whose model image was downscaled (cropSize)', () => {
    // 125% display: model image 1512x810 covering canonical 1890x1012 at
    // (-9,-9); tag px 140,180 land at screen 133,173 (see point.test.ts).
    const geo = {
      imgW: 1920,
      imgH: 1080,
      absLeft: 0,
      absTop: 0,
      winW: 1536,
      winH: 864,
      region: { x: -9, y: -9, w: 1512, h: 810 },
      cropSize: { w: 1890, h: 1012 },
    };
    expect(toImageX(geo, 133)).toBe(140);
    expect(toImageY(geo, 173)).toBe(180);
  });
});

describe('nearSnap', () => {
  const scene = [
    el('p1', 'Product', [700, 400, 980, 450]),
    el('far', 'Chlorine', [1850, 900, 1880, 920]),
  ];

  it('glues a POINT whose label matches a NEAR element to its true center + yields a pair', () => {
    const t = point(760, 430, 'Product');
    const snap = nearSnap(t, scene, GEO);
    expect(snap).not.toBeNull();
    expect(snap!.geom).toEqual({ kind: 'screen-point', x: 840, y: 425 });
    // pair is (hint, true) in image px
    expect(snap!.pair).toEqual({ hx: 760, hy: 430, tx: 840, ty: 425, w: 1 });
  });

  it('glues a BOX whose label matches a NEAR element to its real frame', () => {
    // Drawn box must ENCLOSE the matched element (its frame inside the box
    // dilated 50%) for the glue to fire — so the box here spans the element.
    const t = box(680, 380, 320, 90, 'Product');
    const snap = nearSnap(t, scene, GEO);
    expect(snap).not.toBeNull();
    expect(snap!.geom).toEqual({ kind: 'screen-box', x: 700, y: 400, w: 280, h: 50 });
  });

  it('REJECTS a label that only matches a FAR element (caption can never hijack a chip)', () => {
    // hint at the real structure spot; "Chlorine" caption is 1000+ px away.
    const t = point(150, 600, 'Chlorine');
    const snap = nearSnap(t, scene, GEO);
    expect(snap).not.toBeNull();
    expect(snap!.geom).toBeNull(); // no snap = no hijack
    expect(snap!.pair).toEqual({ hx: 150, hy: 600, tx: 1865, ty: 910, w: 1 }); // but pair for calibration
  });

  it('rejects a BOX onto a far merged OCR row frame', () => {
    const row = el('row', 'Addition', [600, 100, 1500, 120]);
    const t = box(199, 580, 219, 112, 'Addition');
    expect(nearSnap(t, [row], GEO)).toBeNull();
  });

  it('does NOT glue a POINT to a caption whose text matches but sits off the guess', () => {
    // The observed steal: label "new-c-cl-bond" exactly matches a caption line
    // "New C-Cl bond"; the model's guess (810,439) is 173px from the caption
    // center and outside its frame — the old 320px near-check glued it onto the
    // caption text instead of the molecule. Position must stay in image space.
    const caption = el('cap', 'New-C-Cl-bond', [900, 500, 1020, 550]);
    const snap = nearSnap(point(810, 439, 'new-c-cl-bond'), [caption], GEO);
    expect(snap).not.toBeNull();
    expect(snap!.geom).toBeNull();
    expect(snap!.pair).toEqual({ hx: 810, hy: 439, tx: 960, ty: 525, w: 1 });
  });

  it('still glues a POINT inside a neighbor frame even when its center is far', () => {
    // A wide caption column: guess ON the element (inside its frame) still
    // glues regardless of center distance — "on it" beats "near it".
    const wide = el('cap', 'Addition Product', [300, 100, 1100, 140]);
    const snap = nearSnap(point(900, 120, 'addition product'), [wide], GEO);
    expect(snap).not.toBeNull();
    expect(snap!.geom).toEqual({ kind: 'screen-point', x: 700, y: 120 });
  });

  it('does not snap arrows or box-el tags', () => {
    expect(nearSnap(arrow(1, 1, 2, 2, 'Product'), scene, GEO)).toBeNull();
    expect(nearSnap({ kind: 'box-el', id: 'el1', label: 'Product' }, scene, GEO)).toBeNull();
  });

  it('is unaffected by an empty/unusable scene or geometry', () => {
    expect(nearSnap(point(760, 430, 'Product'), null, GEO)).toBeNull();
    const bad = { imgW: 0, imgH: 0, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };
    expect(nearSnap(point(760, 430, 'Product'), scene, bad)).toBeNull();
  });

  it('on a scaled Windows display converts AGENT-physical scene frames to DIP before gluing', () => {
    // 150% display: the scene (UIA/OCR/GetWindowRect) is in PHYSICAL px but
    // screen-* geoms must be absolute screen DIP. Native image grid == physical
    // grid here, so the glue pair stays in image px while the emitted geom is
    // the true DIP center.
    const geo: PointGeo = {
      imgW: 2880,
      imgH: 1620,
      absLeft: 0,
      absTop: 0,
      winW: 1920,
      winH: 1080,
      agentUnitsPerDip: 1.5,
    };
    // Physical 1050..1470 / 600..675 → DIP 700..980 / 400..450.
    const scaled = [el('p1', 'Product', [1050, 600, 1470, 675])];
    // Hint near the element's center IN IMAGE PX (physical/native == 1260,638).
    const snap = nearSnap(point(1280, 640, 'Product'), scaled, geo);
    expect(snap).not.toBeNull();
    // Glued center is the TRUE DIP center — (1260/1.5, 637.5/1.5).
    expect(snap!.geom).toEqual({ kind: 'screen-point', x: 840, y: 425 });
  });

  it('scaled-display box glues to the DIP frame, not the physical one', () => {
    const geo: PointGeo = {
      imgW: 2880,
      imgH: 1620,
      absLeft: 0,
      absTop: 0,
      winW: 1920,
      winH: 1080,
      agentUnitsPerDip: 1.5,
    };
    const scaled = [el('p1', 'Product', [1050, 600, 1470, 675])];
    // Drawn box ENCLOSES the element (element frame inside box dilated 50%).
    const snap = nearSnap(box(1020, 580, 480, 115, 'Product'), scaled, geo);
    expect(snap).not.toBeNull();
    expect(snap!.geom).toEqual({ kind: 'screen-box', x: 700, y: 400, w: 280, h: 50 });
  });

  it('REJECTS a box whose matched element is too big to fit inside the drawn box', () => {
    // The "Chlorobenzene" misfire: a 250x100 drawn box snapped onto a
    // 1094x660 element (2/3 of the screen). The enclosure guard must leave
    // this box in raw image space — no glue.
    const giant = el('g', 'Chlorobenzene', [413, 195, 1507, 855]); // 1094x660
    const t = box(413, 445, 250, 100, 'Chlorobenzene'); // drawn near its center
    expect(nearSnap(t, [giant], GEO)).toBeNull();
  });

  it('ACCEPTS a box whose matched element fits inside the dilated drawn box', () => {
    const icon = el('ic', 'Save', [700, 400, 800, 450]); // 100x50
    const t = box(680, 380, 140, 90, 'Save'); // dilated 50% = 210x135 > 100x50
    const snap = nearSnap(t, [icon], GEO);
    expect(snap).not.toBeNull();
    expect(snap!.geom).toEqual({ kind: 'screen-box', x: 700, y: 400, w: 100, h: 50 });
  });
});

describe('fitGroupShift (the whole-group-sits-left fix)', () => {
  it('returns null with no pairs', () => {
    expect(fitGroupShift([], { maxSize: 1920 })).toBeNull();
  });

  it('a single pair degrades to the pure displacement', () => {
    const a = fitGroupShift([{ hx: 700, hy: 400, tx: 820, ty: 450, w: 1 }], { maxSize: 1920 });
    expect(a).toEqual({ s: 1, tx: 120, ty: 50 });
  });

  it('several pairs with the SAME displacement recover a pure shift', () => {
    const pairs = [
      { hx: 700, hy: 400, tx: 820, ty: 450, w: 1 },
      { hx: 300, hy: 650, tx: 420, ty: 700, w: 1 },
    ];
    const a = fitGroupShift(pairs, { maxSize: 1920 })!;
    expect(a.s).toBeCloseTo(1, 5);
    expect(a.tx).toBeCloseTo(120, 3);
    expect(a.ty).toBeCloseTo(50, 3);
  });

  it('recovers a provider-style downscale within the 15% scale cap', () => {
    // model writes coords ~5% smaller than truth: s = 1/0.95 ≈ 1.05, within cap
    const pairs = [
      { hx: 952, hy: 856, tx: 1000, ty: 900, w: 1 },
      { hx: 475, hy: 285, tx: 500, ty: 300, w: 1 },
    ];
    const a = fitGroupShift(pairs, { maxSize: 1920 })!;
    expect(a.s).toBeCloseTo(1.05, 1);
  });

  it('REJECTS an extreme scale (s far from 1) AND an inconsistent fallback shift', () => {
    // The observed corruption: a "fix" fit s=0.575 on real data, shrinking a
    // whole group to 57% and shoving correct points way off. Real provider
    // resizes are tiny (±few %); any |s-1| > 0.15 is noise — translate only.
    // BUT this set's per-pair shifts (+475,+775 / +950,+950 / +4275,+950) do
    // not agree, so the fallback translation is refused too — never yank the
    // group with a shift the pairs themselves contradict.
    const pairs = [
      { hx: 100, hy: 100, tx: 575, ty: 575, w: 1 },
      { hx: 200, hy: 200, tx: 1150, ty: 1150, w: 1 },
      { hx: 900, hy: 200, tx: 5175, ty: 1150, w: 1 },
    ];
    // scale must never be 0.575 / 5.75 — and with disagreeing pairs nothing is
    // applied at all
    expect(fitGroupShift(pairs, { maxSize: 1920 })).toBeNull();
  });

  it('skips calibration entirely when fewer than 3 consistent pairs remain', () => {
    // 2 agreeing pairs + 1 wild outlier (600px on both axes) — after hard
    // trimming only 2 stay; under the 3-pair floor the similarity fit is
    // skipped and only the surviving consistent shift is applied.
    const a = fitGroupShift([
      { hx: 700, hy: 400, tx: 820, ty: 450, w: 1 },
      { hx: 400, hy: 600, tx: 520, ty: 650, w: 1 },
      { hx: 300, hy: 300, tx: 900, ty: 900, w: 1 },
    ], { maxSize: 1920 })!;
    expect(a.s).toBe(1);
    expect(a.tx).toBeGreaterThan(90);
    expect(a.tx).toBeLessThan(150);
  });

  it('outlier pairs are trimmed before the fit settles', () => {
    const good = { hx: 700, hy: 400, tx: 820, ty: 450, w: 1 };
    const bad = { hx: 300, hy: 300, tx: 900, ty: 900, w: 1 }; // 600px outlier
    const a = fitGroupShift([good, bad, { hx: 400, hy: 600, tx: 520, ty: 650, w: 1 }], { maxSize: 1920 })!;
    // shift dominated by the two agreeing pairs
    expect(a.tx).toBeCloseTo(120, 3);
    expect(a.ty).toBeCloseTo(50, 3);
  });

  it('rejects an absurd scale by falling back to a mean shift', () => {
    const pairs = [
      { hx: 100, hy: 100, tx: 101, ty: 101, w: 1 },
      { hx: 900, hy: 900, tx: 901, ty: 901, w: 1 },
    ];
    const a = fitGroupShift(pairs, { maxSize: 1920 })!;
    expect(a.s).toBe(1);
    expect(a.tx).toBeCloseTo(1, 3);
  });

  it('REFUSES a global shift when pairs do not agree (multi-spot diagram)', () => {
    // Reproduces the chemistry-run corruption: 8 pairs whose per-spot shifts
    // scatter across the diagram — median (87,-258) was applied and yanked
    // still-unplaced tags off their molecules. Scattered shifts => no
    // systematic offset => apply nothing.
    const pairs = [
      { hx: 294, hy: 488, tx: 408, ty: 206, w: 0.6 }, // +114,-282
      { hx: 631, hy: 481, tx: 745, ty: 375, w: 0.6 }, // +114,-106
      { hx: 393, hy: 724, tx: 82, ty: 819, w: 0.6 }, // -311,+95 (border garbage)
      { hx: 696, hy: 487, tx: 964, ty: 332, w: 1 }, // +268,-155 (caption glue)
      { hx: 631, hy: 725, tx: 690, ty: 380, w: 0.6 }, // +59,-345
      { hx: 393, hy: 724, tx: 480, ty: 466, w: 1 }, // +87,-258
      { hx: 696, hy: 735, tx: 783, ty: 477, w: 1 }, // +87,-258
      { hx: 310, hy: 275, tx: 326, ty: 290, w: 1 }, // +16,+15
    ];
    expect(fitGroupShift(pairs, { maxSize: 1456 })).toBeNull();
  });

  it('still applies a LARGE but consistent global shift (real whole-group drift)', () => {
    // A genuine systematic offset (e.g. provider-side resize) is large but
    // tightly agreed — the gate must not kill it.
    const pairs = [
      { hx: 100, hy: 100, tx: 320, ty: 350, w: 0.6 },
      { hx: 300, hy: 500, tx: 522, ty: 750, w: 0.6 },
      { hx: 700, hy: 200, tx: 918, ty: 452, w: 1 },
    ];
    const a = fitGroupShift(pairs, { maxSize: 1920 })!;
    expect(a.s).toBeCloseTo(1, 1);
    expect(a.tx).toBeGreaterThan(215);
    expect(a.tx).toBeLessThan(225);
    expect(a.ty).toBeGreaterThan(245);
    expect(a.ty).toBeLessThan(255);
  });
});

describe('shiftTag', () => {
  const a: Affine = { s: 1, tx: 120, ty: 50 };

  it('shifts a point', () => {
    expect(shiftTag(point(700, 400, 'p'), a)).toEqual({ kind: 'point', x: 820, y: 450, label: 'p', screen: 0 });
  });

  it('shifts a box preserving its size', () => {
    const b = shiftTag(box(100, 100, 50, 30, 'b'), a);
    expect(b).toMatchObject({ kind: 'box', x: 220, y: 150, w: 50, h: 30 });
  });

  it('shifts both arrow endpoints', () => {
    const r = shiftTag(arrow(100, 100, 500, 400, 'a'), a);
    expect(r).toMatchObject({ x1: 220, y1: 150, x2: 620, y2: 450 });
  });

  it('applies a scale term too', () => {
    const r = shiftTag(point(100, 100, 'p'), { s: 0.9, tx: 120, ty: 50 });
    expect(r).toMatchObject({ x: 210, y: 140 }); // round(90+120), round(90+50)
  });

  it('leaves box-el untouched', () => {
    expect(shiftTag({ kind: 'box-el', id: 'x', label: 'q' }, a)).toEqual({ kind: 'box-el', id: 'x', label: 'q' });
  });
});

describe('nearestContentCenter', () => {
  const scene = [
    el('a', 'Category', [600, 100, 1500, 120]), // row-like frame
    el('b', 'Bond', [760, 400, 820, 420]),
    el('c', 'Product', [700, 400, 980, 450]),
  ];

  it('returns the nearest real content to a hint', () => {
    const c = nearestContentCenter(point(760, 430, 'thing'), scene, GEO);
    expect(c).toEqual({ x: 790, y: 410 }); // "Bond" center, closer than "Product"
  });

  it('box tags skip wide row-like frames', () => {
    // Row frame "Category" is closer than "Bond" to the hint, but a box must
    // not re-aim at a caption line — the next nearest non-row anchor wins.
    const c = nearestContentCenter(box(700, 100, 40, 20, 'thing'), scene, GEO);
    expect(c).toEqual({ x: 790, y: 410 }); // "Bond", NOT the row center (1050,110)
  });

  it('clamps to the radius window', () => {
    expect(nearestContentCenter(point(100, 100, 'thing'), scene, GEO)).toBeNull();
  });
});

describe('imageGeomOf', () => {
  it('projects each kind into image-space geometry', () => {
    expect(imageGeomOf(point(1, 2, 'p'))).toEqual({ kind: 'image-point', x: 1, y: 2 });
    expect(imageGeomOf(box(1, 2, 3, 4, 'b'))).toEqual({ kind: 'image-box', x: 1, y: 2, w: 3, h: 4 });
    expect(imageGeomOf(arrow(1, 2, 3, 4, 'a'))).toEqual({ kind: 'image-arrow', x1: 1, y1: 2, x2: 3, y2: 4 });
    expect(imageGeomOf({ kind: 'box-el', id: 'x', label: 'q' })).toBeNull();
  });
});

describe('anchorSnap (deterministic fast-path snap)', () => {
  const scene = [
    el('a', 'Media Library', [900, 60, 1200, 120]), // tile button
    el('b', 'Export', [300, 700, 520, 760]),
    el('c', 'Save', [560, 700, 700, 760]),
  ];
  const container = {
    ...el('w', 'CapCut', [0, 0, 1920, 1080]),
    type: 'Window',
  };
  const rowEl = { ...el('r', 'Caption row', [100, 400, 1700, 420]), type: 'text', source: 'ocr' as const };

  it('glues a LABEL-LESS point to the nearest frame center (the CapCut icon case)', () => {
    const s = anchorSnap({ kind: 'point', x: 950, y: 95, label: '', screen: 0 }, scene, GEO);
    expect(s).not.toBeNull();
    expect(s!.geom).toEqual({ kind: 'screen-point', x: 1050, y: 90 }); // "Media Library" exact center
    expect(s!.pair).toEqual({ hx: 950, hy: 95, tx: 1050, ty: 90, w: 1 });
  });

  it('rejects a guess too far from every frame (no anchor → LLM refine still handles it)', () => {
    expect(anchorSnap({ kind: 'point', x: 80, y: 900, label: '', screen: 0 }, scene, GEO)).toBeNull();
  });

  it('shrinks an oversized BOX down to the element its center lands in', () => {
    const big = box(300, 640, 500, 200, 'toolbar'); // swallows both Save & Export
    const s = anchorSnap(big, scene, GEO);
    expect(s).not.toBeNull();
    // "Save" center (630,730) is nearest to the box center (550,740) → glued to Save's exact bounds.
    expect(s!.geom).toEqual({ kind: 'screen-box', x: 560, y: 700, w: 140, h: 60 });
  });

  it('does not shrink a box whose center lands in NO element frame', () => {
    const big = box(900, 500, 900, 400, 'region'); // contains no element center
    expect(anchorSnap(big, scene, GEO)).toBeNull();
  });

  it('never glues a box to a container window frame', () => {
    const big = box(0, 0, 1900, 1000, 'whole screen');
    expect(anchorSnap(big, [container], GEO)).toBeNull();
  });

  it('never glues a point to a container', () => {
    const s = anchorSnap(point(450, 720, ''), [container, ...scene], GEO);
    expect(s).not.toBeNull();
    expect(s!.el.id).toBe('b'); // nearest REAL frame, not the Window
    expect(anchorSnap(point(450, 720, ''), [container], GEO)).toBeNull();
  });

  it('keeps genuine tight boxes intact (element center never landed inside)', () => {
    const tight = box(306, 702, 40, 30, 'corner'); // inside "Export" but center not captured
    expect(anchorSnap(tight, scene, GEO)).toBeNull();
  });

  it('point does not glue to a far caption row, but a box does not either', () => {
    expect(anchorSnap(point(1500, 410, ''), [rowEl], GEO)).toBeNull();
  });
});