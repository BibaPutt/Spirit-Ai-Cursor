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

function el(id: string, name: string, bounds: [number, number, number, number], source: SceneElement['source'] = 'uia'): SceneElement {
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
    source,
  };
}

const GEO: PointGeo = { imgW: 1920, imgH: 1080, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };

function point(x: number, y: number, label: string): AnnotationTag {
  return { kind: 'point', x, y, label, screen: 0 };
}

describe('correctAnnotGroup visual grounding pass', () => {
  it('anchors an unsolved structure chip onto a grounded element frame', async () => {
    // A molecule icon a UIA tree cannot describe: no scene at all.
    const ground = async (): Promise<SceneElement[]> => [
      el('gndabc', 'Benzene ring', [700, 400, 900, 600], 'grounding'),
    ];
    const tag = point(800, 500, '');
    const out = await correctAnnotGroup([tag], 'fakeimage', GEO, null, {
      ground,
    });
    expect(out.resolved[0]).toEqual({ kind: 'screen-point', x: 800, y: 500 });
    expect(out.logs.some((l) => l.startsWith('grounding:'))).toBe(true);
  });

  it('grounded frames can glue a BOX to itself (shrink-to-fit)', async () => {
    const ground = async (): Promise<SceneElement[]> => [
      el('gndabc', 'Reaction arrow', [1200, 300, 1400, 320], 'grounding'),
    ];
    // A big sloppy box drawn over the arrow gets nailed to the real frame.
    const tag: AnnotationTag = { kind: 'box', x: 1160, y: 280, w: 280, h: 60, label: '', screen: 0 };
    const out = await correctAnnotGroup([tag], 'fakeimage', GEO, null, { ground });
    expect(out.resolved[0]).toEqual({ kind: 'screen-box', x: 1200, y: 300, w: 200, h: 20 });
  });

  it('does NOT call grounding when every tag already snapped to a real scene frame', async () => {
    const ground = vi.fn(async () => []);
    const scene = [el('elA', 'Run', [700, 400, 780, 440])];
    const run = point(740, 420, 'Run'); // near-snaps to elA
    const out = await correctAnnotGroup([run], 'fakeimage', GEO, scene, { ground });
    expect(out.resolved[0]).toEqual({ kind: 'screen-point', x: 740, y: 420 });
    expect(ground).not.toHaveBeenCalled();
  });

  it('never fails annotation when grounding errors (best-effort)', async () => {
    const ground = async () => {
      throw new Error('provider exploded');
    };
    const tag = point(800, 500, '');
    const out = await correctAnnotGroup([tag], 'fakeimage', GEO, null, { ground });
    // tag kept in raw image space, group still resolves
    expect(out.resolved[0]).toEqual({ kind: 'image-point', x: 800, y: 500 });
  });

  it('skips grounding entirely when no image was captured', async () => {
    const ground = vi.fn(async () => []);
    const tag = point(800, 500, '');
    await correctAnnotGroup([tag], null, GEO, null, { ground });
    expect(ground).not.toHaveBeenCalled();
  });
});