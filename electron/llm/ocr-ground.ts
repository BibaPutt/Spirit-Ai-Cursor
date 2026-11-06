// OCR grounding for submit-screen annotations (Phase 7 accuracy fix).
//
// Two roles, one source:
//  1. Elements — EVERY run registers these into the scene so a POST-HOC snap
//     (matchElementByLabel in annotation-snap.ts) binds a text-labelled tag to
//     the exact word box. That is the whole precision story and it never
//     touches the model, so it cannot bias what shapes it draws.
//  2. Note — a text block listing the top word boxes with exact coordinates.
//     This ONLY reaches TEXT-ONLY providers (they cannot see the screenshot
//     and need the anchors to say anything specific). VISION models never see
//     it: handing a vision model "EXACT pixel coordinates, reuse them, never
//     estimate it" railroaded it into annotating only the listed OCR words and
//     killed [BOX]/[ARROW] on rings, icons and muscles.
//
// Pure-ish module: electron nativeImage for decode only; everything else is
// plain data transformations so the shape unit-tests easily.

import { nativeImage } from 'electron';
import type { SceneElement } from '../capture/scene';
import { clusterWords, ocrWordsFromPngBuffer, preprocessForOcr } from '../capture/scene';
import type { PointGeo } from './point';

export type OcrGrounding = {
  note: string;
  elements: SceneElement[];
};

// How many phrases become scene anchors / prompt lines. The visible screen's
// key labels (Reactant, Product, Save…) are almost always within the top ~12
// detected phrases; a longer list costs tokens and shifts attention to text.
const MAX_GROUND_LINES = 12;

// Best-effort: any failure (bad b64, no tesseract, no readable text, empty
// geometry) returns null and the run proceeds exactly as before.
export async function ocrGroundFromScreenshotB64(
  b64: string,
  geo: PointGeo | null,
): Promise<OcrGrounding | null> {
  if (!b64 || !geo || geo.imgW <= 0 || geo.imgH <= 0) return null;
  let img: Electron.NativeImage;
  try {
    img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
  if (img.isEmpty()) return null;
  const { width: imgW, height: imgH } = img.getSize();
  if (imgW < 120 || imgH < 80) return null;

  let words: Awaited<ReturnType<typeof ocrWordsFromPngBuffer>>;
  try {
    words = await ocrWordsFromPngBuffer(preprocessForOcr(img));
  } catch {
    return null;
  }
  if (!words || words.length === 0) return null;

  const phrases = clusterWords(words);
  if (phrases.length === 0) return null;

  // Steps are in IMAGE pixels (they came from a buffer at the image's own
  // size), so the screen conversion uses the same geo the parser decomposes
  // tags with — a label-matched snap is then exact by construction.
  const elements: SceneElement[] = [];
  const lines: string[] = [];
  const pick = phrases.slice(0, MAX_GROUND_LINES);
  for (let i = 0; i < pick.length; i++) {
    const [x1, y1, x2, y2] = pick[i].bounds;
    const sx1 = Math.round(geo.absLeft + (x1 / imgW) * geo.winW);
    const sy1 = Math.round(geo.absTop + (y1 / imgH) * geo.winH);
    const sx2 = Math.round(geo.absLeft + (x2 / imgW) * geo.winW);
    const sy2 = Math.round(geo.absTop + (y2 / imgH) * geo.winH);
    if (sx2 - sx1 < 4 || sy2 - sy1 < 4) continue;
    const center: [number, number] = [Math.round((sx1 + sx2) / 2), Math.round((sy1 + sy2) / 2)];
    elements.push({
      id: `ocrg${i}`,
      type: 'text',
      name: pick[i].text,
      bounds: [sx1, sy1, sx2, sy2],
      center,
      enabled: true,
      clickable: false,
      source: 'ocr',
    });
    lines.push(
      `  #${i + 1} "${pick[i].text}" = {x:${Math.round(x1)}, y:${Math.round(y1)}, w:${Math.round(x2 - x1)}, h:${Math.round(y2 - y1)}}`,
    );
  }
  if (elements.length === 0) return null;

  const note =
    `Detected text on the screenshot with EXACT pixel coordinates in THIS image (x 0-${imgW}, y 0-${imgH}):\n` +
    lines.join('\n') +
    '\n' +
    `This list is an ANCHOR only for the text labels it contains: when a [POINT]/[BOX]/[ARROW] ` +
    `targets ONE OF the labels above, reuse that exact coordinate pair and write the same label ` +
    `so the app binds the tag to the precise box. Everything else — icons, shapes, molecules, ` +
    `regions — is tagged and estimated from the image normally; never let this list limit what ` +
    `you annotate.`;
  return { note, elements };
}