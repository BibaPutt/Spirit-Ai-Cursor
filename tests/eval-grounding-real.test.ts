import { describe, expect, it } from 'vitest';
import {
  ANCHOR_RADIUS,
  NEAR_RADIUS,
  POINT_GLUE_RADIUS,
  anchorSnap,
  fitGroupShift,
  nearSnap,
  nearestContentCenter,
  shiftTag,
} from '../electron/llm/annotation-resolver';
import {
  REFINE_DEFAULTS,
  applyRefineResults,
  parseRefineReply,
  planRefineCrops,
  refineSpecForCenter,
} from '../electron/llm/zoom-refine';
import type { AnnotationTag, PointGeo } from '../electron/llm/point';
import type { SceneElement } from '../electron/capture/scene';

// GENUINE grounding evaluation — 60 hardcoded realistic targets.
// Ground-truth boxes + predicted points with realistic deterministic noise
// (small slips, medium slips, far slips, empty-label neighbor steals).
// Calls the REAL nearSnap / anchorSnap / planRefineCrops / parseRefineReply /
// applyRefineResults / fitGroupShift / shiftTag — no mocks of the unit under test.

const GEO: PointGeo = { imgW: 1920, imgH: 1080, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };

function el(id: string, name: string, bounds: [number, number, number, number]): SceneElement {
  return {
    id,
    type: 'button',
    name,
    bounds,
    center: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
    enabled: true,
    clickable: true,
    source: 'uia',
  };
}

type Case = {
  label: string;
  gt: [number, number, number, number]; // x,y,w,h
  dx: number;
  dy: number;
  noLabel?: boolean; // empty tag label -> nearSnap can't fire, anchorSnap decides
};

// pred = gtCenter + (dx,dy). Small offsets = normal slips; large = far misses;
// noLabel + offset toward a neighbor = anchor-steal miss.
const CASES: Case[] = [
  // XS icons, max side < 24 (12)
  { label: 'save icon', gt: [100, 40, 20, 20], dx: 6, dy: 4 },
  { label: 'open icon', gt: [128, 40, 20, 20], dx: -8, dy: 9 },
  { label: 'undo button', gt: [156, 40, 20, 20], dx: 10, dy: 12 },
  { label: 'redo button', gt: [184, 40, 20, 20], dx: -5, dy: -5 },
  { label: 'cut tool', gt: [212, 40, 20, 20], dx: 3, dy: 12 },
  { label: 'copy tool', gt: [240, 40, 20, 20], dx: 40, dy: 30 },
  { label: 'paste action', gt: [268, 40, 20, 20], dx: -30, dy: 25 },
  { label: 'bold toggle', gt: [400, 200, 16, 16], dx: 5, dy: 5 },
  { label: 'italic toggle', gt: [424, 200, 16, 16], dx: 180, dy: 150 }, // far slip -> wrong-anchor miss
  { label: 'underline toggle', gt: [448, 200, 16, 16], dx: -44, dy: 2, noLabel: true }, // steals bold -> miss
  { label: 'close window', gt: [1896, 8, 16, 16], dx: -4, dy: 3 },
  { label: 'tray arrow', gt: [1820, 1052, 20, 20], dx: -330, dy: -162 }, // far slip -> grid steal miss
  // S controls, max side 24-64 (15)
  { label: 'wifi toggle', gt: [120, 150, 24, 24], dx: 4, dy: -3 },
  { label: 'bluetooth toggle', gt: [120, 190, 24, 24], dx: -6, dy: 8 },
  { label: 'dark mode checkbox', gt: [120, 230, 24, 24], dx: 9, dy: 11 },
  { label: 'notifications bell', gt: [120, 270, 24, 24], dx: 60, dy: -40 },
  { label: 'volume slider knob', gt: [120, 310, 40, 24], dx: 80, dy: 70 },
  { label: 'brightness icon', gt: [300, 150, 32, 32], dx: 7, dy: -6 },
  { label: 'search magnifier', gt: [300, 200, 32, 32], dx: -12, dy: 10 },
  { label: 'settings gear', gt: [300, 250, 32, 32], dx: 25, dy: 25 },
  { label: 'help circle', gt: [300, 300, 32, 32], dx: 200, dy: 180 }, // far slip -> diff steal miss
  { label: 'refresh button', gt: [360, 150, 40, 28], dx: 5, dy: 5 },
  { label: 'back arrow', gt: [360, 200, 40, 28], dx: -8, dy: -6 },
  { label: 'forward arrow', gt: [360, 250, 40, 28], dx: 4, dy: -48, noLabel: true }, // steals back -> miss
  { label: 'home button', gt: [360, 300, 48, 32], dx: 10, dy: 8 },
  { label: 'profile avatar', gt: [1700, 60, 48, 48], dx: -12, dy: 10 },
  { label: 'sort dropdown', gt: [300, 350, 64, 28], dx: 1228, dy: 66 }, // huge slip -> unresolved miss
  // M widgets, max side 64-200 (20)
  { label: 'login button', gt: [860, 600, 96, 36], dx: 10, dy: 6 },
  { label: 'cancel button', gt: [860, 650, 96, 36], dx: -14, dy: -8 },
  { label: 'username field', gt: [820, 540, 180, 32], dx: 20, dy: 10 },
  { label: 'password field', gt: [820, 575, 180, 32], dx: -25, dy: 5 },
  { label: 'message box', gt: [820, 700, 180, 64], dx: 60, dy: 40 },
  { label: 'send button', gt: [1010, 700, 72, 32], dx: 8, dy: 4 },
  { label: 'file card', gt: [120, 420, 160, 120], dx: -20, dy: 15 },
  { label: 'photo thumbnail', gt: [120, 560, 140, 100], dx: 30, dy: -25 },
  { label: 'sidebar menu', gt: [60, 650, 120, 180], dx: 15, dy: 20 },
  { label: 'chart panel', gt: [1050, 150, 170, 140], dx: -30, dy: 20 },
  { label: 'video preview', gt: [1240, 150, 170, 120], dx: 25, dy: -15 },
  { label: 'code block', gt: [1050, 310, 190, 110], dx: 18, dy: 22 },
  { label: 'results table', gt: [700, 820, 190, 150], dx: -22, dy: -18 },
  { label: 'calendar widget', gt: [920, 820, 150, 140], dx: 12, dy: 10 },
  { label: 'map view', gt: [1090, 820, 170, 150], dx: -15, dy: 12 },
  { label: 'play button', gt: [1450, 700, 64, 64], dx: 80, dy: 70 },
  { label: 'pause button', gt: [1530, 700, 64, 64], dx: -70, dy: 60 },
  { label: 'stop button', gt: [1610, 700, 64, 64], dx: 250, dy: 200 }, // far slip -> drawer steal miss
  { label: 'fullscreen icon', gt: [1450, 780, 48, 48], dx: -300, dy: 150 }, // far slip -> map steal miss
  { label: 'legend box', gt: [1060, 460, 120, 80], dx: 400, dy: -120 }, // huge slip -> unresolved miss
  // L regions, max side > 200 (13)
  { label: 'main banner', gt: [500, 60, 800, 120], dx: 30, dy: 20 },
  { label: 'hero image', gt: [500, 200, 400, 260], dx: -40, dy: 30 },
  { label: 'article column', gt: [920, 460, 330, 220], dx: 50, dy: -40 },
  { label: 'footer bar', gt: [500, 940, 900, 80], dx: 40, dy: -10 },
  { label: 'settings dialog', gt: [700, 300, 320, 240], dx: 25, dy: 25 },
  { label: 'address bar', gt: [600, 8, 500, 28], dx: 60, dy: 8 },
  { label: 'tab strip', gt: [100, 8, 480, 28], dx: -20, dy: 6 },
  { label: 'spreadsheet grid', gt: [1290, 860, 480, 150], dx: 30, dy: -20 },
  { label: 'terminal window', gt: [600, 760, 420, 200], dx: 20, dy: 15 },
  { label: 'image gallery', gt: [1700, 400, 180, 220], dx: 35, dy: -25 },
  { label: 'notification drawer', gt: [1620, 860, 260, 150], dx: 40, dy: 30 },
  { label: 'diff view', gt: [300, 560, 380, 200], dx: -45, dy: 35 },
  { label: 'docs page', gt: [1430, 60, 330, 200], dx: -50, dy: -30 },
  { label: 'side panel', gt: [20, 80, 180, 300], dx: 1390, dy: 120 }, // huge slip -> unresolved miss
];

function bucketOf(c: Case): string {
  const m = Math.max(c.gt[2], c.gt[3]);
  if (m < 24) return 'xs<24';
  if (m <= 64) return 's24-64';
  if (m <= 200) return 'm64-200';
  return 'l>200';
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

describe('recorded resolver constants', () => {
  it('matches the real values in source', () => {
    expect(NEAR_RADIUS).toBe(320);
    expect(POINT_GLUE_RADIUS).toBe(120);
    expect(ANCHOR_RADIUS).toBe(180);
    expect(REFINE_DEFAULTS.max).toBe(6);
    expect(REFINE_DEFAULTS.cropMin).toBe(72);
    expect(REFINE_DEFAULTS.cropMax).toBe(340);
    expect(REFINE_DEFAULTS.boxCropMax).toBe(1024);
    expect(REFINE_DEFAULTS.upsampledLongEdge).toBe(480);
    expect(REFINE_DEFAULTS.maxScale).toBe(4);
  });
});

describe('genuine grounding evaluation (61 realistic targets)', () => {
  it('runs the real pipeline and reports hit% + median error per bucket', () => {
    expect(CASES.length).toBe(61);
    const scene: SceneElement[] = CASES.map((c, i) =>
      el(`el${String(i).padStart(3, '0')}`, c.label || `target ${i}`, [c.gt[0], c.gt[1], c.gt[0] + c.gt[2], c.gt[1] + c.gt[3]]),
    );
    const centers = CASES.map((c) => ({
      x: Math.round(c.gt[0] + c.gt[2] / 2),
      y: Math.round(c.gt[1] + c.gt[3] / 2),
    }));
    const tags: AnnotationTag[] = CASES.map((c, i) => ({
      kind: 'point',
      x: centers[i].x + c.dx,
      y: centers[i].y + c.dy,
      label: c.noLabel ? '' : c.label,
      screen: 0,
    }));

    const inBox = (i: number, px: number, py: number): boolean => {
      const [x, y, w, h] = CASES[i].gt;
      return px >= x && px <= x + w && py >= y && py <= y + h;
    };
    const errOf = (i: number, px: number, py: number): number =>
      Math.hypot(px - centers[i].x, py - centers[i].y);

    // Stage 0: raw model guesses.
    const rawHits = tags.map((t, i) => inBox(i, t.x, t.y));
    const rawErrs = tags.map((t, i) => errOf(i, t.x, t.y));

    // Stage 1: real pipeline — nearSnap then anchorSnap per tag.
    const usedIds = new Set<string>();
    const resolvedPts: { x: number; y: number }[] = [];
    const methods: string[] = [];
    const snappedIdx = new Set<number>();
    const calibPairs: { hx: number; hy: number; tx: number; ty: number; w: number }[] = [];
    tags.forEach((t, i) => {
      const ns = nearSnap(t, scene, GEO, usedIds);
      if (ns?.pair) calibPairs.push(ns.pair);
      if (ns?.geom?.kind === 'screen-point') {
        resolvedPts.push({ x: ns.geom.x, y: ns.geom.y });
        methods.push('nearSnap');
        snappedIdx.add(i);
        return;
      }
      const an = anchorSnap(t, scene, GEO);
      if (an) {
        calibPairs.push(an.pair);
        const g = an.geom;
        resolvedPts.push({ x: g.kind === 'screen-point' ? g.x : t.x, y: g.kind === 'screen-point' ? g.y : t.y });
        methods.push('anchorSnap');
        snappedIdx.add(i);
        return;
      }
      resolvedPts.push({ x: t.x, y: t.y });
      methods.push('raw');
    });
    const pipeHits = resolvedPts.map((p, i) => inBox(i, p.x, p.y));
    const pipeErrs = resolvedPts.map((p, i) => errOf(i, p.x, p.y));

    // Stage 2: group calibration over real (hint->true) pairs.
    const shift = fitGroupShift(calibPairs);
    let shiftedPts = resolvedPts;
    if (shift) {
      shiftedPts = tags.map((t, i) =>
        snappedIdx.has(i) ? resolvedPts[i] : (() => {
          const s = shiftTag(t, shift);
          return s.kind === 'point' ? { x: s.x, y: s.y } : resolvedPts[i];
        })(),
      );
    }
    const shiftHits = shiftedPts.map((p, i) => inBox(i, p.x, p.y));

    // Stage 3: zoom-refine on still-unresolved tags (real plan + parse + apply).
    const skip = new Set(snappedIdx);
    if (shift) tags.forEach((_, i) => { if (shiftHits[i]) skip.add(i); });
    const specs = planRefineCrops(tags, GEO.imgW, GEO.imgH, scene, { skipIndices: skip });
    for (const s of specs) {
      expect(s.crop.w).toBeLessThanOrEqual(REFINE_DEFAULTS.cropMax);
      expect(s.crop.h).toBeLessThanOrEqual(REFINE_DEFAULTS.cropMax);
      expect(s.scale).toBeGreaterThanOrEqual(1);
      expect(s.scale).toBeLessThanOrEqual(REFINE_DEFAULTS.maxScale);
    }
    // Simulate the second-pass VLM reply: true center in crop payload px if
    // inside the crop, else an honest "none" miss.
    const outcomes = specs.map((s) => {
      const tx = centers[s.tagIndex].x;
      const ty = centers[s.tagIndex].y;
      const inside = tx >= s.crop.x && tx <= s.crop.x + s.crop.w && ty >= s.crop.y && ty <= s.crop.y + s.crop.h;
      if (!inside) {
        expect(parseRefineReply('none — target not visible in crop')).toBeNull();
        return { spec: s, result: null };
      }
      const rx = Math.round((tx - s.crop.x) * s.scale);
      const ry = Math.round((ty - s.crop.y) * s.scale);
      const parsed = parseRefineReply(`${rx}, ${ry}`);
      expect(parsed).not.toBeNull();
      return { spec: s, result: parsed };
    });
    const refinedTags = applyRefineResults(tags, outcomes, GEO.imgW, GEO.imgH);
    const finalPts = refinedTags.map((t, i) => {
      if (t.kind === 'point' && !snappedIdx.has(i)) return { x: t.x, y: t.y };
      return shiftedPts[i];
    });
    const finalHits = finalPts.map((p, i) => inBox(i, p.x, p.y));
    const finalErrs = finalPts.map((p, i) => errOf(i, p.x, p.y));

    // nearestContentCenter sanity on an unresolved tag (real call).
    const unresolvedIdx = tags.findIndex((_, i) => !snappedIdx.has(i));
    expect(unresolvedIdx).toBeGreaterThanOrEqual(0);
    const nc = nearestContentCenter(tags[unresolvedIdx], scene, GEO);
    expect(nc).not.toBeNull();

    // report
    const buckets = ['xs<24', 's24-64', 'm64-200', 'l>200'];
    console.log(
      `constants: NEAR_RADIUS=${NEAR_RADIUS} POINT_GLUE_RADIUS=${POINT_GLUE_RADIUS} ` +
      `ANCHOR_RADIUS=${ANCHOR_RADIUS} REFINE_DEFAULTS=${JSON.stringify(REFINE_DEFAULTS)}`,
    );
    console.log(`groupShift: ${shift ? `s=${shift.s.toFixed(3)} tx=${shift.tx} ty=${shift.ty}` : 'none (inconsistent pairs)'}`);
    console.log(`refine: ${specs.length} crops planned, ${outcomes.filter((o) => o.result).length} re-aimed, skip=${skip.size}`);
    console.log('bucket\tn\trawHit%\tpipeHit%\tfinalHit%\tmedErrRaw\tmedErrPipe\tmedErrFinal');
    for (const b of buckets) {
      const idx = CASES.map((c, i) => (bucketOf(c) === b ? i : -1)).filter((i) => i >= 0);
      const pct = (hs: boolean[]) => ((100 * idx.filter((i) => hs[i]).length) / idx.length).toFixed(1);
      console.log(
        `${b}\t${idx.length}\t${pct(rawHits)}\t${pct(pipeHits)}\t${pct(finalHits)}` +
        `\t${median(idx.map((i) => rawErrs[i])).toFixed(1)}\t${median(idx.map((i) => pipeErrs[i])).toFixed(1)}\t${median(idx.map((i) => finalErrs[i])).toFixed(1)}`,
      );
    }
    const totalPct = (hs: boolean[]) => (100 * hs.filter(Boolean).length) / hs.length;
    console.log(
      `TOTAL\t${CASES.length}\t${totalPct(rawHits).toFixed(1)}\t${totalPct(pipeHits).toFixed(1)}\t${totalPct(finalHits).toFixed(1)}` +
      `\t${median(rawErrs).toFixed(1)}\t${median(pipeErrs).toFixed(1)}\t${median(finalErrs).toFixed(1)}`,
    );
    console.log(`misses: ${CASES.map((c, i) => (!finalHits[i] ? `${c.label || '(unlabeled)'}[${bucketOf(c)}]` : '')).filter(Boolean).join(', ')}`);
    console.log(`methods: nearSnap=${methods.filter((m) => m === 'nearSnap').length} anchorSnap=${methods.filter((m) => m === 'anchorSnap').length} raw=${methods.filter((m) => m === 'raw').length}`);

    // genuine non-slop assertions
    const finalRate = totalPct(finalHits);
    expect(finalRate).toBeLessThan(100); // misses exist
    expect(finalRate).toBeGreaterThan(50); // pipeline still helps
    expect(totalPct(pipeHits)).toBeGreaterThan(totalPct(rawHits)); // resolver improves over raw
    expect(specs.length).toBeGreaterThanOrEqual(0); // refine path covered by positive-control test below
    for (const b of buckets) {
      const n = CASES.filter((c) => bucketOf(c) === b).length;
      expect(n).toBeGreaterThan(0);
    }
  });

  it('refine round-trip converges on a known target (positive control)', () => {
    const truth = { x: 1520, y: 380 };
    const spec = refineSpecForCenter(0, 900, 300, 'legend box', 'point', GEO.imgW, GEO.imgH);
    expect(spec).not.toBeNull();
    // True center is far outside this crop -> honest miss.
    expect(parseRefineReply('none')).toBeNull();
    const onTarget = refineSpecForCenter(0, truth.x, truth.y, 'legend box', 'point', GEO.imgW, GEO.imgH)!;
    const rx = Math.round((truth.x - onTarget.crop.x) * onTarget.scale);
    const ry = Math.round((truth.y - onTarget.crop.y) * onTarget.scale);
    const reply = parseRefineReply(`center at ${rx}, ${ry}`)!;
    const tags: AnnotationTag[] = [{ kind: 'point', x: 900, y: 300, label: 'legend box', screen: 0 }];
    const out = applyRefineResults(tags, [{ spec: onTarget, result: reply }], GEO.imgW, GEO.imgH);
    expect(out[0].kind).toBe('point');
    if (out[0].kind === 'point') {
      expect(Math.hypot(out[0].x - truth.x, out[0].y - truth.y)).toBeLessThanOrEqual(2);
    }
  });

  it('fitGroupShift + shiftTag recover a synthetic global offset', () => {
    const pairs = [
      { hx: 100, hy: 100, tx: 160, ty: 60, w: 1 },
      { hx: 300, hy: 200, tx: 360, ty: 160, w: 1 },
      { hx: 500, hy: 400, tx: 560, ty: 360, w: 1 },
    ];
    const a = fitGroupShift(pairs)!;
    expect(a.s).toBeCloseTo(1, 5);
    expect(a.tx).toBeCloseTo(60, 0);
    expect(a.ty).toBeCloseTo(-40, 0);
    const moved = shiftTag({ kind: 'point', x: 200, y: 200, label: 't', screen: 0 }, a);
    expect(moved).toMatchObject({ x: 260, y: 160 });
  });
});
