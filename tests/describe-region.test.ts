import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// describe_region: crop a rectangular region of the current attached
// screenshot and ask the vision bridge to read it. The bridge + crop are
// mocked here (covered for real in vision-bridge.test.ts); the current-image
// tracker is real module state so the tool's gating logic is tested.

const hoisted = vi.hoisted(() => ({
  describeScreenshot: vi.fn(async () => 'A toolbar with a red stop button.'),
  cropRegionB64: vi.fn(async () => 'Y3JvcHBlZA=='),
}));

vi.mock('../electron/llm/vision-bridge', () => ({
  describeScreenshot: hoisted.describeScreenshot,
  cropRegionB64: hoisted.cropRegionB64,
}));

import { describeRegionTool } from '../electron/llm/tools/describe-region';
import { clearCurrentImage, setCurrentImage } from '../electron/llm/current-image';

describe('describe_region tool', () => {
  beforeEach(() => {
    clearCurrentImage();
    hoisted.cropRegionB64.mockResolvedValue('Y3JvcHBlZA==');
    hoisted.describeScreenshot.mockResolvedValue('A toolbar with a red stop button.');
  });

  afterEach(() => {
    clearCurrentImage();
    vi.clearAllMocks();
  });

  it('rejects non-numeric or non-positive box arguments', async () => {
    expect(await describeRegionTool.execute({ x: 1, y: 2, w: 0, h: 10 }, {} as never)).toBe(
      'Error: describe_region needs numeric x, y, w, h with w and h > 0.',
    );
    expect(await describeRegionTool.execute({ x: 1, y: 2, w: 'abc', h: 10 }, {} as never)).toContain(
      'Error',
    );
    expect(hoisted.cropRegionB64).not.toHaveBeenCalled();
  });

  it('fails fast when no screenshot is attached yet', async () => {
    const res = await describeRegionTool.execute({ x: 1, y: 2, w: 10, h: 10 }, {} as never);
    expect(res).toBe(
      'Error: no screenshot in context. Call see_screen first to attach the current screen.',
    );
    expect(hoisted.cropRegionB64).not.toHaveBeenCalled();
  });

  it('crops the current image and returns the bridge description', async () => {
    setCurrentImage('Zm9vLWJhci1pbWFnZQ==');
    const res = await describeRegionTool.execute(
      { x: 5, y: 8, w: 100, h: 60, question: 'the stop button' },
      {} as never,
    );
    expect(hoisted.cropRegionB64).toHaveBeenCalledWith('Zm9vLWJhci1pbWFnZQ==', 5, 8, 100, 60);
    expect(hoisted.describeScreenshot).toHaveBeenCalledWith('Y3JvcHBlZA==', 'the stop button');
    expect(res).toBe('Vision readback of region (5,8 100x60px):\nA toolbar with a red stop button.');
  });

  it('reports a crop failure as an error string', async () => {
    setCurrentImage('Zm9vLWJhci1pbWFnZQ==');
    hoisted.cropRegionB64.mockResolvedValue(null);
    const res = await describeRegionTool.execute({ x: 0, y: 0, w: 10, h: 10 }, {} as never);
    expect(res).toBe('Error: could not crop that region from the current screenshot.');
  });

  it('reports a bridge failure as an error string', async () => {
    setCurrentImage('Zm9vLWJhci1pbWFnZQ==');
    hoisted.cropRegionB64.mockResolvedValue('Y3JvcHBlZA==');
    hoisted.describeScreenshot.mockResolvedValue(null);
    const res = await describeRegionTool.execute({ x: 0, y: 0, w: 10, h: 10 }, {} as never);
    expect(res).toContain('the vision bridge could not describe this region');
  });

  it('omits the question focus when not provided', async () => {
    setCurrentImage('Zm9vLWJhci1pbWFnZQ==');
    await describeRegionTool.execute({ x: 0, y: 0, w: 10, h: 10 }, {} as never);
    expect(hoisted.describeScreenshot).toHaveBeenCalledWith('Y3JvcHBlZA==', undefined);
  });

  it('declares the expected OpenAI-style function schema', () => {
    const fn = describeRegionTool.declaration.function;
    expect(fn.name).toBe('describe_region');
    expect(Object.keys(fn.parameters.properties)).toEqual(['x', 'y', 'w', 'h', 'question']);
    expect(fn.parameters.required).toEqual(['x', 'y', 'w', 'h']);
  });
});