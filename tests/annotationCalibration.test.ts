import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'Spirit',
    getVersion: () => 'test',
    getPath: () => tmpdir(),
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({
      isEmpty: () => true,
      getSize: () => ({ width: 1920, height: 1080 }),
    })),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../electron/llm/providers/router', () => ({
  resolveProviderChain: () => ({ chain: [] }),
  streamCompletion: () => {},
}));

vi.mock('../electron/store/settings', () => ({
  getSettings: () => ({}),
}));

import { correctAnnotGroup } from '../electron/llm/point-refine';
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

describe('correctAnnotGroup group calibration', () => {
  it('corrects every still-image tag by the shift measured from glue pairs', async () => {
    const scene = [
      el('elA', 'Run', [700, 400, 780, 440]),
      el('elB', 'Stop', [900, 400, 980, 440]),
      el('elC', 'Pause', [1100, 400, 1180, 440]),
    ];
    // Three label-matched tags sit 20px left / 10px up of their real elements
    // (the provider's systematic offset). Glue pairs measure that same shift.
    const tRun = point(720, 410, 'Run');
    const tStop = point(920, 410, 'Stop');
    const tPause = point(1120, 410, 'Pause');
    // A structure chip with NO anchor — it must be moved by exactly that
    // measured group shift, not left at its raw (offset) coordinates.
    const tStruct = arrow(400, 600, 700, 600, 'Reaction arrow');
    const out = await correctAnnotGroup([tRun, tStop, tPause, tStruct], null, GEO, scene);
    expect(out.tags[0]).toEqual(tRun); // glued -> unchanged raw tag
    expect(out.tags[1]).toEqual(tStop);
    expect(out.tags[2]).toEqual(tPause);
    // shifted by +20,+10 = the glue-pair displacement
    expect(out.tags[3]).toMatchObject({ x1: 420, y1: 610, x2: 720, y2: 610 });
    // resolved authority updated accordingly
    expect(out.resolved[0]).toEqual({ kind: 'screen-point', x: 740, y: 420 });
    expect(out.resolved[1]).toEqual({ kind: 'screen-point', x: 940, y: 420 });
    expect(out.resolved[2]).toEqual({ kind: 'screen-point', x: 1140, y: 420 });
    expect(out.resolved[3]).toEqual({ kind: 'image-arrow', x1: 420, y1: 610, x2: 720, y2: 610 });
    expect(out.logs.some((l) => l.includes('calibration'))).toBe(true);
  });

  it('boxes are shifted without changing their size', async () => {
    const scene = [
      el('elA', 'Run', [700, 400, 780, 440]),
      el('elB', 'Stop', [900, 400, 980, 440]),
      el('elC', 'Pause', [1100, 400, 1180, 440]),
    ];
    const tRun = point(720, 410, 'Run');
    const tStop = point(920, 410, 'Stop');
    const tPause = point(1120, 410, 'Pause');
    const tBox = box(400, 300, 120, 40, 'Widget');
    const out = await correctAnnotGroup([tRun, tStop, tPause, tBox], null, GEO, scene);
    expect(out.tags[3]).toMatchObject({ x: 420, y: 310, w: 120, h: 40 });
  });

  it('a single glue pair does NOT hijack the group (no calibration)', async () => {
    const scene = [el('elA', 'Run', [700, 400, 780, 440])];
    const tRun = point(720, 410, 'Run');
    const tStruct = arrow(400, 600, 700, 600, 'Reaction arrow');
    const out = await correctAnnotGroup([tRun, tStruct], null, GEO, scene);
    // only one pair -> calibration is skipped, raw coords stay
    expect(out.tags[1]).toEqual(tStruct);
    expect(out.resolved[0]).toEqual({ kind: 'screen-point', x: 740, y: 420 });
  });

  it('no-op when there is no geometry or no scene', async () => {
    const t = point(100, 100, 'thing');
    const out = await correctAnnotGroup([t], null, null, null);
    expect(out.tags[0]).toEqual(t);
    expect(out.resolved[0]).toEqual({ kind: 'image-point', x: 100, y: 100 });
    expect(out.logs.some((l) => l.includes('calibration'))).toBe(false);
  });

  it('far caption matches contribute pairs but never hijack the group position', async () => {
    const scene = [
      el('elA', 'Run', [700, 400, 780, 440]),
      el('elB', 'Stop', [900, 400, 980, 440]),
      el('far', 'Chlorine', [1850, 900, 1880, 920]),
    ];
    // Run/Stop glue (near) with a +20,+10 shift. "Chlorine" matches but sits
    // 1000+ px away (no snap, no geom), so its pair is a +1715,+310 outlier
    // that the robust fit trims rather than letting it drag the group.
    const tRun = point(720, 410, 'Run');
    const tStop = point(920, 410, 'Stop');
    const tChlorine = point(150, 600, 'Chlorine');
    const out = await correctAnnotGroup([tRun, tStop, tChlorine], null, GEO, scene);
    // group shift still lands as +20,+10 (from the two agreeing near glues)
    expect(out.tags[2]).toMatchObject({ x: 170, y: 610 });
    expect(out.resolved[0]).toEqual({ kind: 'screen-point', x: 740, y: 420 });
  });

  it('refine pass is opt-in: no zoom crops when opts.refine is absent', async () => {
    // Without opts.refine the pass-2 branch is skipped entirely so the old
    // near-snap + calibration behavior is byte-identical (and costs nothing).
    const geo: PointGeo = { imgW: 1456, imgH: 819, absLeft: 0, absTop: 0, winW: 1536, winH: 864 };
    const t = point(554, 886, 'Broken Bond');
    const out = await correctAnnotGroup([t], null, geo, null, { refine: {} });
    expect(out.tags[0]).toEqual(t);
    expect(out.resolved[0]).toEqual({ kind: 'image-point', x: 554, y: 886 });
  });

  it('slightly-OOB anchorless tags stay as refine candidates (not OOB-dropped by the resolver)', async () => {
    // The log case: "Broken Bond" at (554,886) in an 819-tall image. The
    // resolver keeps it as an image-point (pass-2 refine will clamp+re-aim it
    // in handlers, which HAS the screenshot); it must NOT be marked as a
    // snappable element or shifted into the group without a pair.
    const geo: PointGeo = { imgW: 1456, imgH: 819, absLeft: 0, absTop: 0, winW: 1536, winH: 864 };
    const t = point(554, 886, 'Broken Bond');
    const out = await correctAnnotGroup([t], null, geo, null);
    expect(out.tags[0]).toEqual(t);
    expect(out.resolved[0]).toEqual({ kind: 'image-point', x: 554, y: 886 });
    expect(out.logs.join(' ')).toContain('kept/refined/calibrated');
  });
});