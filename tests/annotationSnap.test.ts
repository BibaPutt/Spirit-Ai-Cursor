import { describe, expect, it } from 'vitest';
import { matchElementByLabel } from '../electron/llm/annotation-snap';
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

const SCENE: SceneElement[] = [
  el('el1', 'Save', [10, 20, 110, 40]),
  el('el2', 'Save as…', [130, 20, 230, 40]),
  el('el3', 'Close button', [900, 200, 990, 224]),
  el('el4', 'Downloads folder', [300, 300, 500, 330]),
  el('el5', 'C=O', [0, 0, 1, 1]),
];

describe('matchElementByLabel', () => {
  it('exact normalized equality wins regardless of case/spacing', () => {
    expect(matchElementByLabel('close button', SCENE)?.id).toBe('el3');
    expect(matchElementByLabel('  Close   Button ', SCENE)?.id).toBe('el3');
  });

  it('empty / too-short labels never match (guards against "ok"-style noise)', () => {
    expect(matchElementByLabel('', SCENE)).toBeNull();
    expect(matchElementByLabel('ok', SCENE)).toBeNull();
    expect(matchElementByLabel('hi', SCENE)).toBeNull();
  });

  it('a short-but-real label still matches exactly (chemistry "C=O")', () => {
    expect(matchElementByLabel('C=O', SCENE)?.id).toBe('el5');
  });

  it('substring matches either direction', () => {
    expect(matchElementByLabel('Downloads', SCENE)?.id).toBe('el4'); // tag ⊂ name
    expect(matchElementByLabel('Downloads folder for', SCENE)?.id).toBe('el4'); // name ⊂ tag
  });

  it('breaks "Save"-style ties by proximity to the tag coordinates', () => {
    // Neither element is an exact 'Save' — proximity decides.
    const els = [
      el('a', 'Save As', [10, 20, 110, 40]),
      el('b', 'Save Snapshot', [130, 20, 230, 40]),
    ];
    expect(matchElementByLabel('Save', els, 190, 30)?.id).toBe('b'); // near the right one
    expect(matchElementByLabel('Save', els, 40, 30)?.id).toBe('a');
  });

  it('returns null when nothing matches', () => {
    expect(matchElementByLabel('Totally unrelated thing', SCENE)).toBeNull();
    expect(matchElementByLabel('Save', [])).toBeNull();
  });

  it('a BOX tag does not snap to a merged OCR row it did not draw on', () => {
    // A table row merged into one wide frame hundreds of px from the drawn
    // box: the structure box must NOT glue onto it (that was the "benzene"
    // misfire — box drawn at the structure, snapped onto a far table row).
    const row = el('ocr-row', 'Benzene', [600, 100, 1300, 120]);
    const rowed = [row];
    expect(matchElementByLabel('Benzene', rowed, 200, 300, { x: 199, y: 580, w: 219, h: 112 })).toBeNull();
  });

  it('a BOX tag still snaps to a tight text/heading frame near the draw', () => {
    const heading = el('ocr-h', 'Bonds Formed Summary', [1227, 375, 1305, 391]);
    const els = [heading];
    expect(
      matchElementByLabel('Bonds Formed Summary', els, 850, 315, { x: 750, y: 240, w: 200, h: 150 })?.id,
    ).toBe('ocr-h');
  });

  it('a BOX tag snaps onto a merged row when the drawn frame overlaps it', () => {
    const row = el('ocr-row', 'Reaction Types', [300, 100, 900, 120]);
    const els = [row];
    expect(
      matchElementByLabel('Reaction Types', els, 600, 110, { x: 450, y: 90, w: 300, h: 40 })?.id,
    ).toBe('ocr-row');
  });

  it('a point (no box frame) still snaps to a row frame — name beats pixels', () => {
    const row = el('ocr-row', 'Benzene', [600, 100, 1300, 120]);
    expect(matchElementByLabel('Benzene', [row])?.id).toBe('ocr-row');
  });

  it('an element already claimed by another tag is not matched again (uniqueness)', () => {
    const els = [
      el('elA', 'Chlorobenzene', [413, 195, 507, 290]),
    ];
    const used = new Set<string>();
    // First tag claims the element.
    const first = matchElementByLabel('Chlorobenzene', els, 450, 245, undefined, used);
    expect(first?.id).toBe('elA');
    // Second tag with the same label must NOT steal the same element.
    expect(matchElementByLabel('Chlorobenzene', els, 460, 255, undefined, used)).toBeNull();
  });

  it('uniqueness skips the taken element but still matches a different one', () => {
    const els = [
      el('elA', 'Save', [10, 20, 110, 40]),
      el('elB', 'Save as…', [130, 20, 230, 40]),
    ];
    const used = new Set<string>(['elA']);
    expect(matchElementByLabel('Save', els, 150, 30, undefined, used)?.id).toBe('elB');
  });
});