import { describe, expect, it } from 'vitest';
import {
  annotationImageNote,
  isArrowOutOfImageBounds,
  isBoxOutOfImageBounds,
  isOutOfImageBounds,
  mapBoxToScreen,
  mapPointToScreen,
  type PointGeo,
} from '../electron/llm/point';

const DOWNSCALED: PointGeo = {
  // 1920x1080 display shown as a 1280x720 image (the double-scale hazard).
  imgW: 1280,
  imgH: 720,
  absLeft: 0,
  absTop: 0,
  winW: 1920,
  winH: 1080,
};

describe('isOutOfImageBounds — dropping garbage instead of drifting it', () => {
  it('accepts coordinates inside the image', () => {
    expect(isOutOfImageBounds({ x: 0, y: 0 }, DOWNSCALED)).toBe(false);
    expect(isOutOfImageBounds({ x: 1279, y: 719 }, DOWNSCALED)).toBe(false);
  });

  it('rejects a screen-pixel coordinate written into a 1280x720 image', () => {
    // The model "double-scales" 1920x1080 coords into the image space.
    expect(isOutOfImageBounds({ x: 1500, y: 900 }, DOWNSCALED)).toBe(true);
    expect(isOutOfImageBounds({ x: 1920, y: 1080 }, DOWNSCALED)).toBe(true);
  });

  it('allows the ~1.05x slack (a chip just past the crop corner is fine)', () => {
    expect(isOutOfImageBounds({ x: 1344, y: 719 }, DOWNSCALED)).toBe(false); // == 1280*1.05
    expect(isOutOfImageBounds({ x: 1345, y: 719 }, DOWNSCALED)).toBe(true);
  });

  it('rejects negatives and unusable geometry', () => {
    expect(isOutOfImageBounds({ x: -1, y: 10 }, DOWNSCALED)).toBe(true);
    const zero: PointGeo = { imgW: 0, imgH: 0, absLeft: 0, absTop: 0, winW: 0, winH: 0 };
    expect(isOutOfImageBounds({ x: 1, y: 1 }, zero)).toBe(true);
  });
});

describe('isBoxOutOfImageBounds', () => {
  it('flags a box anywhere outside the image', () => {
    expect(isBoxOutOfImageBounds({ x: 640, y: 360, w: 320, h: 120 }, DOWNSCALED)).toBe(false);
    // Box that starts in-image but runs off the right edge.
    expect(isBoxOutOfImageBounds({ x: 1200, y: 360, w: 200, h: 100 }, DOWNSCALED)).toBe(true);
    // Double-scaled box: x/y in screen pixels, size in screen pixels.
    expect(isBoxOutOfImageBounds({ x: 1329, y: 215, w: 660, h: 240 }, DOWNSCALED)).toBe(true);
  });
});

describe('isArrowOutOfImageBounds', () => {
  it('flags either endpoint escaping the image', () => {
    const ok = { x1: 10, y1: 10, x2: 100, y2: 50 };
    expect(isArrowOutOfImageBounds(ok, DOWNSCALED)).toBe(false);
    expect(isArrowOutOfImageBounds({ ...ok, x2: 1500 }, DOWNSCALED)).toBe(true);
    expect(isArrowOutOfImageBounds({ ...ok, y1: -5 }, DOWNSCALED)).toBe(true);
  });
});

describe('clamping + mapping of in-bounds tags', () => {
  it('converts a valid image point to screen space', () => {
    expect(mapPointToScreen({ x: 640, y: 360, label: '', screen: 0 }, DOWNSCALED)).toEqual({
      x: 960,
      y: 540,
    });
  });

  it('clamps negative pixels to the display start instead of going off-screen', () => {
    const b = mapBoxToScreen({ x: -40, y: -10, w: 200, h: 100 }, DOWNSCALED);
    expect(b).not.toBeNull();
    expect(b!.x).toBe(0);
    expect(b!.y).toBe(0);
    expect(b!.w).toBeGreaterThan(0);
  });
});

describe('annotationImageNote (model-facing geometry caption)', () => {
  it('restates ONLY the image bounds so the model writes IMAGE pixels', () => {
    const note = annotationImageNote(DOWNSCALED);
    expect(note).toContain('1280');
    expect(note).toContain('720');
    expect(note).toContain('0 to 1280');
    expect(note).toContain('0 to 720');
    // The display dimensions are mentioned for context, but
    // the model is told coordinates are IMAGE pixels, not screen pixels.
    expect(note).toContain('1920x1080');
    expect(note).not.toContain('screen pixels');
  });

  it('returns empty when geometry is missing', () => {
    expect(annotationImageNote(null)).toBe('');
  });
});