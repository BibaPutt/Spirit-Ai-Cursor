import { describe, expect, it } from 'vitest';
import {
  omniparserProvider,
  parseSidecarOutput,
} from '../electron/capture/omniparser-sidecar';
import type { DetectedObject } from '../electron/capture/visual-grounding';

describe('parseSidecarOutput', () => {
  it('returns detections in image pixel space, clamped to the image', () => {
    const out = parseSidecarOutput(
      'WARNING: some python noise\n{"ok": true, "objects": [{"label": "Run", "box": [100, 90, 260, 130]}, {"label": "Flask", "box": [10, 20, 30, 40]}]}\n',
      1920,
      1080,
    );
    expect(out).not.toBeNull();
    expect(out![0]).toEqual({ label: 'Run', box: [100, 90, 260, 130] });
    expect(out![1]).toEqual({ label: 'Flask', box: [10, 20, 30, 40] });
  });

  it('clamps boxes past the image edge', () => {
    const out = parseSidecarOutput(
      JSON.stringify({ ok: true, objects: [{ label: 'x', box: [-50, -10, 5000, 9000] }] }),
      1920,
      1080,
    );
    expect(out![0].box).toEqual([0, 0, 1920, 1080]);
  });

  it('drops malformed lines but still parses the last clean JSON line', () => {
    const out = parseSidecarOutput('not json\n{"ok": true, "objects": []}', 10, 10);
    expect(out).toEqual([]);
  });

  it('returns null on ok:false or unparseable output', () => {
    expect(parseSidecarOutput('{"ok": false, "error": "deps missing"}', 10, 10)).toBeNull();
    expect(parseSidecarOutput('garbage', 10, 10)).toBeNull();
    expect(parseSidecarOutput('{"ok": true}', 10, 10)).toBeNull();
  });

  it('skips objects with missing labels or malformed boxes', () => {
    const out = parseSidecarOutput(
      JSON.stringify({
        ok: true,
        objects: [
          { label: '', box: [0, 0, 10, 10] },
          { label: 'a', box: [0, 0, 10] },
          { label: 'b', box: [0, 0, 10, 10] },
        ],
      }),
      100,
      100,
    );
    expect(out).toEqual([{ label: 'b', box: [0, 0, 10, 10] }]);
  });
});

describe('omniparserProvider', () => {
  it('is unavailable when the sidecar script is missing', () => {
    const p = omniparserProvider({ scriptPath: 'C:\\definitely\\missing\\omniparser_sidecar.py' });
    expect(p.source).toBe('omniparser');
    expect(p.isAvailable()).toBe(false);
    expect(p.lastError()).toContain('script not found');
  });

  it('is unavailable when the OmniParser checkout dir is missing', () => {
    const p = omniparserProvider({
      scriptPath: __filename, // exists
      dir: 'C:\\definitely\\missing',
    });
    expect(p.isAvailable()).toBe(false);
    expect(p.lastError()).toContain('OmniParser checkout');
  });

  it('parses a fake runner stdout into detections', async () => {
    const runner = async () => ({
      stdout: JSON.stringify({
        ok: true,
        objects: [
          { label: 'Play icon', box: [120, 90, 180, 150] },
        ],
      }),
      code: 0,
    });
    const p = omniparserProvider({
      scriptPath: __filename,
      dir: __dirname,
      runner,
    });
    expect(p.isAvailable()).toBe(true);
    const objs: DetectedObject[] | null = await p.detect('/fake.png', 1920, 1080);
    expect(objs).toEqual([{ label: 'Play icon', box: [120, 90, 180, 150] }]);
  });

  it('latches hard-failed (non-zero code) so a dead python is never re-spawned per tag', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { stdout: 'Traceback (most recent call last):\nboom', code: 1 };
    };
    const p = omniparserProvider({ scriptPath: __filename, dir: __dirname, runner });
    expect(await p.detect('/fake.png', 10, 10)).toBeNull();
    expect(await p.detect('/fake.png', 10, 10)).toBeNull();
    expect(p.lastError()).toContain('sidecar failed');
    // Second detect must NOT spawn again — the latch turns the provider off.
    expect(calls).toBe(1);
    expect(p.isAvailable()).toBe(false);
  });
});