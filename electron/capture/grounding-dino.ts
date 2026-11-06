// GroundingDINO tiny ONNX provider — the lightweight/no-Python grounding tier.
// Runs a GroundingDINO-TINY inference-only export through onnxruntime-node on
// CPU: ~340MB model vs OmniParser's ~2.7GB Python stack, good accuracy on
// general "UI element" detection, no Python to install. Ideal for potato PCs.
//
// Availability is filesystem-driven and NEVER invasive:
//   - a model directory (env SPIRIT_GROUNDING_MODEL, else
//     resources/models/grounding-dino) containing `model.onnx` + `vocab.txt`,
//   - onnxruntime-node resolvable at runtime (loaded lazily via dynamic import
//     so a missing dependency just reports unavailable — zero startup cost, and
//     the default build does not bundle it).
// The exported model is expected to follow the standard inference-only
// GroundingDINO signature:
//   inputs:  pixel_values  [1,3,800,800] float32 (ImageNet-normalized)
//            input_ids     [1,256]       int64
//            attention_mask[1,256]       int64
//   outputs: pred_logits   [1,1,300]     logits
//            pred_boxes    [1,1,300,4]   cx cy w h in the 800x800 input grid
// (boxes ARE NOT normalized and ARE NOT denormalized by the head here; the
//  decoder below maps the 800-grid straight to the source image pixels.)
// Any deviation (different opset, same-name outputs, shape mismatch) fails
// soft: detect() returns null and the orchestrator falls back to no grounding,
// exactly as if no model existed. The pure tokenizer + decoder are exported
// and unit-tested so a wrong export is caught by logs, never a crash.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedObject, GroundingProvider } from './visual-grounding';

export const DINO_GRID = 800;
export const DINO_MAX_TOKENS = 256;

// Model discovery

export function dinoModelDirCandidates(): string[] {
  return [
    process.env.SPIRIT_GROUNDING_MODEL ?? '',
    join(process.cwd(), 'resources', 'models', 'grounding-dino'),
  ].filter(Boolean);
}

export function resolveDinoModel(): { dir: string; onnx: string; vocab: string } | null {
  const dir = dinoModelDirCandidates().find((d) => existsSync(d));
  if (!dir) return null;
  const onnx = join(dir, 'model.onnx');
  const vocab = join(dir, 'vocab.txt');
  if (!existsSync(onnx) || !existsSync(vocab)) return null;
  return { dir, onnx, vocab };
}

// Grounding prompt. A generic "what UI things exist?" phrase catches icons,
// buttons, inputs and panels; override for focused searches. The text tokenizer
// template below mirrors GroundingDINO's "det <phrase>" caption convention.
export function dinoPhrase(): string {
  return process.env.SPIRIT_GROUNDING_PHRASE?.trim() || 'button icon text input panel';
}

// BERT wordpiece tokenizer (pure). GroundingDINO-adjacent exports tokenize
// with a bert-base vocab; the special token ids are BERT's fixed values.
const SPECIAL = {
  '[PAD]': 0,
  '[UNK]': 100,
  '[CLS]': 101,
  '[SEP]': 102,
} as const;

export function loadVocab(vocabText: string): Map<string, number> {
  const map = new Map<string, number>();
  const lines = vocabText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const w = lines[i].replace(/\r/g, '');
    if (w !== '') map.set(w, i);
  }
  return map;
}

export function wordpieceTokens(word: string, vocab: Map<string, number>): string[] {
  const low = word.toLowerCase();
  if (vocab.has(low)) return [low];
  if (low === '') return [];
  const out: string[] = [];
  let start = 0;
  while (start < low.length) {
    let end = low.length;
    let found: string | null = null;
    while (start < end) {
      const sub = (start === 0 ? '' : '##') + low.slice(start, end);
      if (vocab.has(sub)) {
        found = sub;
        break;
      }
      end -= 1;
    }
    if (found === null) {
      out.push('[UNK]');
      break;
    }
    out.push(found);
    start += found.length - (found.startsWith('##') ? 2 : 0);
  }
  return out;
}

// Split a phrase on non-alphanumeric runs (keeps hyphens/digits intact within
// a token run) then wordpiece each word.
export function tokenizePhrase(
  phrase: string,
  vocab: Map<string, number>,
  maxLen = DINO_MAX_TOKENS,
): { ids: number[]; mask: number[] } {
  const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const w of words) tokens.push(...wordpieceTokens(w, vocab));
  void maxLen;
  const ids = [SPECIAL['[CLS]'], ...tokens.map((t) => vocab.get(t) ?? SPECIAL['[UNK]']), SPECIAL['[SEP]']];
  const mask = ids.map(() => 1);
  return { ids, mask };
}

// Decoder (pure): logits+boxes -> DetectedObject[] in source-image pixels.

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export type DinoBox = {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
};

// Boxes arrive as cx,cy,w,h in the model's 800x800 input grid. Map each to
// source-image pixel space per-axis (gridX -> imgW, gridY -> imgH).
export function decodeDinoBoxes(
  logits: Float32Array,
  boxes: Float32Array,
  imgW: number,
  imgH: number,
  scoreThreshold = 0.25,
): DinoBox[] {
  const n = logits.length;
  const out: DinoBox[] = [];
  for (let i = 0; i < n; i += 1) {
    const score = sigmoid(logits[i]);
    if (score < scoreThreshold) continue;
    const cx = boxes[i * 4] ?? 0;
    const cy = boxes[i * 4 + 1] ?? 0;
    const w = boxes[i * 4 + 2] ?? 0;
    const h = boxes[i * 4 + 3] ?? 0;
    if (w <= 0 || h <= 0) continue;
    const sx = (cx / DINO_GRID) * imgW;
    const sy = (cy / DINO_GRID) * imgH;
    const sw = (w / DINO_GRID) * imgW;
    const sh = (h / DINO_GRID) * imgH;
    out.push({ cx: sx, cy: sy, w: sw, h: sh, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function iou(a: DinoBox, b: DinoBox): number {
  const ax1 = a.cx - a.w / 2;
  const ay1 = a.cy - a.h / 2;
  const ax2 = a.cx + a.w / 2;
  const ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2;
  const by1 = b.cy - b.h / 2;
  const bx2 = b.cx + b.w / 2;
  const by2 = b.cy + b.h / 2;
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter === 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// Greedy NMS, IoU 0.5 (GroundingDINO default), keeps at most maxOut of the
// boxes sorted by score (already sorted by decodeDinoBoxes).
export function dinoNms(boxes: DinoBox[], iouThreshold = 0.5, maxOut = 50): DinoBox[] {
  const picked: DinoBox[] = [];
  for (const b of boxes) {
    const duplicate = picked.some((p) => iou(p, b) > iouThreshold);
    if (!duplicate) {
      picked.push(b);
      if (picked.length >= maxOut) break;
    }
  }
  return picked;
}

export function dinoToDetections(
  boxes: DinoBox[],
  label: string,
  imgW: number,
  imgH: number,
): DetectedObject[] {
  return boxes.map((b) => ({
    label,
    box: [
      Math.round(Math.max(0, b.cx - b.w / 2)),
      Math.round(Math.max(0, b.cy - b.h / 2)),
      Math.round(Math.min(imgW, b.cx + b.w / 2)),
      Math.round(Math.min(imgH, b.cy + b.h / 2)),
    ] as [number, number, number, number],
  }));
}

// Provider

export function dinoProvider(): GroundingProvider {
  let lastError: string | null = null;

  const provider: GroundingProvider = {
    source: 'grounding-dino',
    isAvailable: () => resolveDinoModel() !== null,
    lastError: () => lastError,
    async detect(imagePath, imgW, imgH) {
      const model = resolveDinoModel();
      if (!model) {
        lastError = 'grounding-dino model missing (drop model.onnx + vocab.txt into resources/models/grounding-dino)';
        return null;
      }
      try {
        // dino-inference owns image decode + lazy onnxruntime import, so a
        // missing package or bad export only surfaces here as null.
        const { dinoInfer } = await import('./dino-inference');
        return await dinoInfer(imagePath, imgW, imgH, { vocabPath: model.vocab });
      } catch (err) {
        lastError = `grounding-dino inference failed: ${(err as Error).message}`;
        return null;
      }
    },
  };
  return provider;
}