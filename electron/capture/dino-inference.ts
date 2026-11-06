// GroundingDINO inference runner — the only place that touches images and
// onnxruntime. Kept OUT of grounding-dino.ts so the tokenizer/decoder stay
// pure and cheaply unit-testable; this module is lazily imported by the
// provider only when a model is actually present.
//
// Pipeline: sharp decodes+resizes the PNG to an 800x800 RGB float (stretch
// fill), ImageNet-normalized into CHW; the text side tokenizes the grounding
// phrase into BERT ids/mask; the session runs once; the decoder maps the 800
// grid back to the source image's pixels. Every failure is a soft null with a
// logged reason — a wrong opset never crashes the app.

import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DINO_GRID,
  decodeDinoBoxes,
  dinoNms,
  dinoPhrase,
  dinoToDetections,
  loadVocab,
  tokenizePhrase,
  type DinoBox,
} from './grounding-dino';
import type { DetectedObject } from './visual-grounding';

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.226];

type Prepared = {
  pixelValues: Float32Array;
  inputIds: number[];
  attentionMask: number[];
};

// Vocab parse cache: the BERT wordpiece table for a given vocab.txt never
// changes mid-session, but prepare() was re-reading and re-splitting it on
// every detection. tokenizePhrase only reads the map, so sharing it is safe.
const vocabCache = new Map<string, Map<string, number>>();

export async function prepare(
  imagePath: string,
  vocabPath: string,
  phrase: string,
): Promise<Prepared> {
  // sharp.decode? raw().toBuffer() on a resized 800x800 gives HWC RGB bytes.
  const raw = await sharp(imagePath)
    .resize(DINO_GRID, DINO_GRID, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const channels = info.channels; // 3 after removeAlpha
  const pixelValues = new Float32Array(3 * DINO_GRID * DINO_GRID);
  // Convert HWC -> CHW with ImageNet normalization.
  for (let p = 0; p < DINO_GRID * DINO_GRID; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = data[p * channels + c] * (1 / 255);
      pixelValues[c * DINO_GRID * DINO_GRID + p] = (v - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
    }
  }
  let vocab = vocabCache.get(vocabPath);
  if (!vocab) {
    vocab = loadVocab(await readFile(vocabPath, 'utf8'));
    vocabCache.set(vocabPath, vocab);
  }
  const { ids, mask } = tokenizePhrase(phrase, vocab);
  return { pixelValues, inputIds: ids, attentionMask: mask };
}

// Session cache: InferenceSession.create() loads + optimizes the whole
// GroundingDINO graph (hundreds of ms and ~100MB) — recreating it per
// detection made every grounded box pay the full model load. The path keys
// the cache so a model swap (SPIRIT_GROUNDING_MODEL) still takes effect;
// onnxruntime sessions support concurrent run(), so overlapping detections
// share one session safely.
type DinoSession = {
  run(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
};
let cachedSession: { onnx: string; session: DinoSession } | null = null;

// onnxruntime module stays out of the static import graph entirely (loaded
// lazily, only when a model is actually present).
type OrtModule = {
  InferenceSession: { create(path: string): Promise<DinoSession> };
  Tensor: new (type: string, data: number[] | Float32Array, dims: number[]) => unknown;
};
let ortModule: OrtModule | null = null;

async function getOrt(): Promise<OrtModule> {
  if (!ortModule) ortModule = (await import('onnxruntime-node')) as OrtModule;
  return ortModule;
}

async function getDinoSession(onnx: string): Promise<DinoSession> {
  if (cachedSession && cachedSession.onnx === onnx) return cachedSession.session;
  const ort = await getOrt();
  const session = await ort.InferenceSession.create(onnx);
  cachedSession = { onnx, session };
  return session;
}

export async function dinoInfer(
  imagePath: string,
  imgW: number,
  imgH: number,
  opts: { vocabPath: string; phrase?: string },
): Promise<DetectedObject[] | null> {
  const phrase = opts.phrase ?? dinoPhrase();
  const prepared = await prepare(imagePath, opts.vocabPath, phrase);
  const onnx = resolveModelOnnxPath();
  if (!onnx) return null;
  const ort = await getOrt();
  const session = await getDinoSession(onnx);
  const feeds = {
    pixel_values: new ort.Tensor('float32', prepared.pixelValues, [1, 3, DINO_GRID, DINO_GRID]),
    input_ids: new ort.Tensor('int64', prepared.inputIds, [1, prepared.inputIds.length]),
    attention_mask: new ort.Tensor('int64', prepared.attentionMask, [1, prepared.attentionMask.length]),
  };
  const results = await session.run(feeds);
  const { logits, boxes } = extractLogitsBoxes(results);
  if (!logits || !boxes) return null;
  const decoded: DinoBox[] = decodeDinoBoxes(logits, boxes, imgW, imgH);
  return dinoToDetections(dinoNms(decoded), phrase, imgW, imgH);
}

// Resolve the ONNX path the same way the provider does (env dir first, else
// resources/models/grounding-dino). Kept local so this module never pulls the
// provider's session bookkeeping into the inference path.
function resolveModelOnnxPath(): string | null {
  const candidates = [
    process.env.SPIRIT_GROUNDING_MODEL ?? '',
    join(process.cwd(), 'resources', 'models', 'grounding-dino'),
  ].filter(Boolean);
  const dir = candidates.find((d) => {
    try {
      return existsSync(join(d, 'model.onnx'));
    } catch {
      return false;
    }
  });
  return dir ? join(dir, 'model.onnx') : null;
}

// Outputs arrive under names that vary between exports ('logits'/'pred_logits'
// and 'pred_boxes'/'boxes'/'predictions'). Match by name first, then fall back
// to shape alone (300 logits, 1200 = 300x4 boxes) so a renamed export works.
function extractLogitsBoxes(
  results: Record<string, unknown>,
): { logits: Float32Array | null; boxes: Float32Array | null } {
  const tensors = Object.entries(results).map(([, v]) => {
    // onnxruntime tensors expose .data as a typed array
    return ((v as { data?: unknown }).data ?? null) as Float32Array | null;
  });
  let logits = tensors.find((t) => t && t.length === 300) ?? null;
  let boxes = tensors.find((t) => t && t.length === 1200) ?? null;
  // Fall back to a shape-only match (some exports rename or reorder outputs).
  if (!logits) logits = tensors.find((t) => t && t.length === 300) ?? null;
  if (!boxes) boxes = tensors.find((t) => t && t.length === 1200) ?? null;
  return { logits, boxes };
}