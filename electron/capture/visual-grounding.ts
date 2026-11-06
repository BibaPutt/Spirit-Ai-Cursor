// Visual grounding subsystem — turns a SCREENSHOT into real element frames for
// content the UIA/AX/OCR tree cannot describe (icons, molecule structures,
// charts, toolbars with no a11y text). It plugs into the annotation pipeline:
// tags that stayed in raw image space after near-snap get a second chance to
// glue onto grounded frames (see point-refine.ts opts.ground).
//
// Two providers sit behind one narrow interface, always with a graceful NOOP:
//   - OmniParser (Python sidecar): best-in-class UI detection + captioning,
//     needs the OmniParser V2/V3 repo installed (heavy, ~2GB with torch).
//   - GroundingDINO tiny (ONNX, onnxruntime-node): light ~340MB model, no
//     Python, runs on any CPU — the "potato PC" tier.
// A machine with neither keeps exactly today's behavior: every provider
// reports unavailable, resolution returns the NOOP provider, and nothing
// else in the pipeline knows grounding exists.
//
// Everything below is pure Node (no Electron imports) so vitest can exercise
// the detection->screen mapping and provider resolution directly.

import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PointGeo } from '../llm/point';
import { regionCropScale } from '../llm/point';
import type { SceneElement } from './scene';

// One object the model found, with a caption label, in IMAGE pixel space.
export type DetectedObject = {
  label: string;
  box: [number, number, number, number]; // x1, y1, x2, y2
};

export type GroundSource = 'omniparser' | 'grounding-dino' | 'none';

// A provider can detect objects in a screenshot on disk (PNG path). All boxes
// are reported in the IMAGE's own pixel coordinates — the pipeline converts to
// screen DIP via the geometry, exactly like tag coordinates.
export interface GroundingProvider {
  readonly source: Exclude<GroundSource, 'none'> | 'none';
  /** True when the provider could fire right now (model + runtime present). */
  isAvailable(): boolean;
  /** Human-readable reason when unavailable, for logs. */
  lastError(): string | null;
  /**
   * Detect objects in a PNG on disk. Returns null on ANY failure (missing
   * model, bad opset, timeout) — never throws. Callers decide how loudly to
   * log. May be slow on first call (lazy model load).
   */
  detect(imagePath: string, imgW: number, imgH: number): Promise<DetectedObject[] | null>;
}

const NOOP: GroundingProvider = {
  source: 'none',
  isAvailable: () => false,
  lastError: () => 'no grounding provider configured (install OmniParser, or drop an ONNX model)',
  detect: async () => null,
};

// Provider resolution. Order: OmniParser sidecar (best labels) when it can
// actually run, else GroundingDINO ONNX (lightweight, always a chance). Any
// hard failure degrades to the other tier, and `SPIRIT_VISUAL_GROUNDING=0`
// disables the whole subsystem (mirrors SPIRIT_CUA_DRIVER=0).

export type GroundingResolver = {
  omniparser: GroundingProvider;
  dino: GroundingProvider;
};

// resolveProvider picks between the two providers the modules expose. Both
// report unavailable when not installed, so this never throws.
export async function resolveGroundingProvider(): Promise<GroundingProvider> {
  if (process.env.SPIRIT_VISUAL_GROUNDING === '0') return NOOP;
  const { omniparserProvider } = await import('./omniparser-sidecar');
  if (omniparserProvider().isAvailable()) return omniparserProvider();
  const { dinoProvider } = await import('./grounding-dino');
  if (dinoProvider().isAvailable()) return dinoProvider();
  return NOOP;
}

// Detection -> scene elements (AGENT space, same grid as UIA/OCR elements).
// toImageElement in annotation-resolver.ts maps agent->image; we invert its
// exact formula so a grounded element lands where the model's image px say.

export function groundingElements(
  objects: DetectedObject[],
  geo: PointGeo,
): SceneElement[] {
  if (objects.length === 0 || geo.imgW <= 0 || geo.imgH <= 0 || geo.winW <= 0 || geo.winH <= 0) {
    return [];
  }
  const sf = geo.agentUnitsPerDip ?? 1;
  const rx = geo.region?.x ?? 0;
  const ry = geo.region?.y ?? 0;
  const s = regionCropScale(geo);
  const elements: SceneElement[] = [];
  for (const o of objects) {
    const [x1, y1, x2, y2] = o.box;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    if (x2 - x1 < 4 || y2 - y1 < 4) continue; // degenerate slivers help nobody
    // Detector boxes live in the same (possibly downscaled) model image as the
    // tags; un-resize by the crop ratio before mapping into canonical px.
    const ax1 = Math.round((geo.absLeft + ((Math.max(0, x1) * s.sx + rx) / geo.imgW) * geo.winW) * sf);
    const ay1 = Math.round((geo.absTop + ((Math.max(0, y1) * s.sy + ry) / geo.imgH) * geo.winH) * sf);
    const ax2 = Math.round((geo.absLeft + ((Math.min(geo.imgW, x2 * s.sx) + rx) / geo.imgW) * geo.winW) * sf);
    const ay2 = Math.round((geo.absTop + ((Math.min(geo.imgH, y2 * s.sy) + ry) / geo.imgH) * geo.winH) * sf);
    const cx = Math.round((ax1 + ax2) / 2);
    const cy = Math.round((ay1 + ay2) / 2);
    const bucket = `${Math.round(cx / 16)},${Math.round(cy / 16)}`;
    const id = `gnd${createHash('sha256')
      .update(`grounding|${o.label.replace(/\s+/g, ' ').toLowerCase()}|${bucket}`)
      .digest('hex')
      .slice(0, 8)}`;
    elements.push({
      id,
      type: 'Grounded',
      name: o.label.trim(),
      bounds: [ax1, ay1, ax2, ay2],
      center: [cx, cy],
      enabled: true,
      clickable: true,
      source: 'grounding',
    });
  }
  return elements;
}

// Base64 convenience: providers take an image PATH, but the annotation
// pipeline hands over a base64 PNG. Round-trip through a temp file so the two
// sides stay decoupled (and the file is cleaned up on every path, including
// provider failure).

export async function detectFromBase64(
  provider: GroundingProvider,
  base64: string,
  imgW: number,
  imgH: number,
): Promise<DetectedObject[] | null> {
  if (!provider.isAvailable() || !base64) return null;
  const file = join(tmpdir(), `spirit-grounding-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await writeFile(file, Buffer.from(base64, 'base64'));
    return await provider.detect(file, imgW, imgH);
  } catch {
    return null;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}