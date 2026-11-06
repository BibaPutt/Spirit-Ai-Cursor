import { describe, expect, it } from 'vitest';
import { detectFromBase64, groundingElements, resolveGroundingProvider } from '../electron/capture/visual-grounding';
import type { PointGeo } from '../electron/llm/point';

const GEO: PointGeo = { imgW: 1920, imgH: 1080, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };

describe('groundingElements (image px -> agent space)', () => {
  it('maps a detection box onto the same pixel grid as the scene, 1:1 at 100%', () => {
    const els = groundingElements(
      [{ label: 'Benzene ring', box: [700, 400, 900, 600] }],
      GEO,
    );
    expect(els).toHaveLength(1);
    const e = els[0];
    expect(e.name).toBe('Benzene ring');
    expect(e.bounds).toEqual([700, 400, 900, 600]);
    expect(e.center).toEqual([800, 500]);
    expect(e.source).toBe('grounding');
    expect(e.id).toMatch(/^gnd[0-9a-f]{8}$/);
    expect(e.enabled).toBe(true);
    expect(e.clickable).toBe(true);
  });

  it('maps through a crop region offset', () => {
    const cropped: PointGeo = {
      imgW: 1920,
      imgH: 1080,
      absLeft: 100,
      absTop: 50,
      winW: 1920,
      winH: 1080,
      region: { x: 200, y: 100, w: 800, h: 450 },
    };
    const els = groundingElements([{ label: 'Starch', box: [0, 0, 800, 450] }], cropped);
    // x: absLeft + ((0 + 200)/1920)*1920 = 300 ; width of box ends at region end
    expect(els[0].bounds[0]).toBe(300);
    expect(els[0].bounds[1]).toBe(150);
  });

  it('respects agentUnitsPerDip (Windows physical pixels)', () => {
    // A 1280x720 model image of a 1920x1080 DIP display at scale 1.5: the
    // physical grid is 2880x1620, so an image pixel maps to 2.25 physical px.
    const scaled: PointGeo = { imgW: 1280, imgH: 720, absLeft: 0, absTop: 0, winW: 1920, winH: 1080, agentUnitsPerDip: 1.5 };
    const els = groundingElements([{ label: 'Run', box: [640, 360, 1280, 720] }], scaled);
    expect(els[0].bounds).toEqual([1440, 810, 2880, 1620]);
    expect(els[0].center).toEqual([2160, 1215]);
  });

  it('drops degenerate slivers and out-of-range boxes instead of poisoning the scene', () => {
    const els = groundingElements(
      [
        { label: 'tiny', box: [10, 10, 12, 10] }, // 2x0 -> too thin
        { label: 'ok', box: [100, 100, 250, 200] },
        { label: 'oob', box: [-500, -500, 5000, 5000] }, // clamped to image
      ],
      GEO,
    );
    expect(els).toHaveLength(2);
    expect(els.map((e) => e.name)).toEqual(['ok', 'oob']);
    // oob clamped inside the 1920x1080 image
    expect(els[1].bounds[2]).toBe(1920);
  });

  it('returns [] for an empty detection set or a bad geo', () => {
    expect(groundingElements([], GEO)).toEqual([]);
    expect(groundingElements([{ label: 'x', box: [0, 0, 10, 10] }], { imgW: 0, imgH: 0, absLeft: 0, absTop: 0, winW: 0, winH: 0 })).toEqual([]);
  });
});

describe('detectFromBase64', () => {
  it('returns null without ever writing a file when the provider is unavailable', async () => {
    const unavailable = {
      source: 'none' as const,
      isAvailable: () => false,
      lastError: () => 'not installed',
      detect: async () => {
        throw new Error('must not be called');
      },
    };
    expect(await detectFromBase64(unavailable, 'AAAA', 100, 100)).toBeNull();
  });
});

describe('resolveGroundingProvider', () => {
  it('returns the NOOP provider when SPIRIT_VISUAL_GROUNDING=0 (feature flag)', async () => {
    const prev = process.env.SPIRIT_VISUAL_GROUNDING;
    process.env.SPIRIT_VISUAL_GROUNDING = '0';
    try {
      const p = await resolveGroundingProvider();
      expect(p.source).toBe('none');
      expect(p.isAvailable()).toBe(false);
      expect(await p.detect('/nope.png', 10, 10)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.SPIRIT_VISUAL_GROUNDING;
      else process.env.SPIRIT_VISUAL_GROUNDING = prev;
    }
  });
});