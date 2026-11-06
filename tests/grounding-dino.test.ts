import { describe, expect, it } from 'vitest';
import {
  decodeDinoBoxes,
  dinoToDetections,
  loadVocab,
  sigmoid,
  dinoNms,
  tokenizePhrase,
  wordpieceTokens,
  DINO_GRID,
} from '../electron/capture/grounding-dino';

// A minimal bert-like vocab exercising the specials + wordpiece behavior.
const VOCAB = loadVocab(
  [
    '[PAD]',
    '[UNK]',
    '[CLS]',
    '[SEP]',
    'button',
    'icon',
    'text',
    'UI',
    '##bar',
    '##n',
    'tool',
  ].join('\n'),
);

describe('tokenizer (bert wordpiece)', () => {
  it('loads a vocab mapping tokens to ids', () => {
    expect(VOCAB.get('button')).toBe(4);
    expect(VOCAB.size).toBe(11);
  });

  it('emits literal tokens for known words and [UNK]/## pieces otherwise', () => {
    expect(wordpieceTokens('button', VOCAB)).toEqual(['button']);
    expect(wordpieceTokens('toolbar', VOCAB)).toEqual(['tool', '##bar']);
    expect(wordpieceTokens('zzzz', VOCAB)).toEqual(['[UNK]']);
  });

  it('builds a [CLS]...phrase...[SEP] encoding with attention mask', () => {
    const { ids, mask } = tokenizePhrase('button icon', VOCAB);
    expect(ids[0]).toBe(101); // [CLS]
    expect(ids[ids.length - 1]).toBe(102); // [SEP]
    expect(ids).toEqual([101, 4, 5, 102]);
    expect(mask).toEqual([1, 1, 1, 1]);
  });

  it('ignores punctuation and lowercases', () => {
    const { ids } = tokenizePhrase('Button, ICON!', VOCAB);
    expect(ids).toEqual([101, 4, 5, 102]);
  });
});

describe('decoder (logits/boxes -> image pixel detections)', () => {
  it('sigmoid maps a logit to (0,1)', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5);
    expect(sigmoid(10)).toBeGreaterThan(0.999);
    expect(sigmoid(-10)).toBeLessThan(0.001);
  });

  it('decodes cxcywh from the 800-grid to image pixels and thresholds by score', () => {
    const logits = new Float32Array([0, 5, 10]); // scores .5, .99, .99999
    const boxes = new Float32Array([
      // cx, cy, w, h in 800-grid
      400, 400, 200, 100,
      200, 540, 80, 40,
      40, 40, 800, 800,
    ]);
    const out = decodeDinoBoxes(logits, boxes, 1920, 1080, 0.995);
    // Only logit 10 (score ~0.99995) passes the 0.995 threshold; logit 5 is
    // ~0.993 and logit 0 is 0.5.
    expect(out).toHaveLength(1);
    expect(out[0].cx).toBeCloseTo(96); // (40/800)*1920
    expect(out[0].w).toBeCloseTo(1920);
    expect(out[0].h).toBeCloseTo(1080);
  });

  it('sorts detected boxes by score descending', () => {
    const logits = new Float32Array([5, 0, 3]);
    const boxes = new Float32Array([100, 100, 10, 10, 300, 300, 10, 10, 200, 200, 10, 10]);
    const out = decodeDinoBoxes(logits, boxes, 800, 800);
    expect(out[0].cx).toBe(100);
    expect(out[1].cx).toBe(200);
    expect(out[2].cx).toBe(300);
  });

  it('NMS suppresses overlapping boxes and keeps disjoint ones', () => {
    const a = { cx: 100, cy: 100, w: 40, h: 40, score: 0.99 };
    const b = { cx: 105, cy: 105, w: 40, h: 40, score: 0.5 }; // heavy overlap
    const c = { cx: 500, cy: 500, w: 40, h: 40, score: 0.4 }; // disjoint
    const kept = dinoNms([a, b, c], 0.5);
    expect(kept.map((k) => k.cx)).toEqual([100, 500]);
  });

  it("maps NMS'd boxes to DetectedObject[] inside the image bounds", () => {
    const boxes = [{ cx: 50, cy: 60, w: 20, h: 30, score: 0.9 }];
    const dets = dinoToDetections(boxes, 'UI element', 100, 100);
    expect(dets).toEqual([
      { label: 'UI element', box: [40, 45, 60, 75] },
    ]);
  });

  it('decodes each box off the model 800-grid even when the image is smaller', () => {
    const logits = new Float32Array([10]);
    const boxes = new Float32Array([800, 800, 800, 800]);
    const out = decodeDinoBoxes(logits, boxes, 100, 100);
    expect(out[0].cx).toBeCloseTo(100);
    expect(out[0].w).toBeCloseTo(100);
    expect(DINO_GRID).toBe(800);
  });
});