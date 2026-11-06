import { describe, expect, it } from 'vitest';
import { mergeSceneLayers } from '../electron/llm/scene-merge';
import type { SceneElement } from '../electron/capture/scene';

function el(id: string, name: string, cx: number, cy: number, source: SceneElement['source']): SceneElement {
  return {
    id,
    type: 'Button',
    name,
    bounds: [cx - 20, cy - 10, cx + 20, cy + 10],
    center: [cx, cy],
    enabled: true,
    clickable: true,
    source,
  };
}

describe('mergeSceneLayers', () => {
  it('merges disjoint layers in order', () => {
    const merged = mergeSceneLayers([
      [el('u1', 'Play', 100, 100, 'uia')],
      [el('o1', 'Timeline', 500, 200, 'ocr')],
    ]);
    expect(merged.map((e) => e.id)).toEqual(['u1', 'o1']);
  });

  it('drops a later element that sits on an earlier center (duplicate control)', () => {
    const merged = mergeSceneLayers([
      [el('u1', 'Play', 100, 100, 'uia')],
      [el('o1', 'play', 102, 101, 'ocr')],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('u1');
  });

  it('keeps two elements of the same name at different spots', () => {
    const merged = mergeSceneLayers([
      [el('a1', 'Save', 50, 50, 'ocr')],
      [el('a2', 'Save', 400, 50, 'ocr')],
    ]);
    expect(merged).toHaveLength(2);
  });

  it('treats null/undefined and empty layers as no-ops', () => {
    expect(mergeSceneLayers([null, undefined, [] as SceneElement[]])).toEqual([]);
    expect(mergeSceneLayers([])).toEqual([]);
  });

  it('first occurrence wins when layers are ordered UIA-first', () => {
    const merged = mergeSceneLayers([
      [el('u1', 'Export', 300, 300, 'uia')],
      [el('o1', 'Export', 299, 302, 'ocr')],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('uia');
  });
});