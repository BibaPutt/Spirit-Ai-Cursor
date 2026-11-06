// Paint-to-select OCR: the user drags a region on screen while the box is
// open ("paint to select a text"), and we run tesseract over exactly that
// region. The crop is preprocessed (grayscale, contrast boost, 2x upscale for
// small regions) before Tesseract sees it, and we use --oem 1 (LSTM neural
// net) which is dramatically better than the legacy engine. PSM 6 (uniform
// text block) is primary with PSM 11 (sparse) fallback.

import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nativeImage } from 'electron';
import { frameHash } from './frame-hash';
import { captureRectFromDisplay } from './screenshot';
import { getTesseractPath } from './tesseract';

const execFileP = promisify(execFile);

// OCR result cache keyed by the input frame's hash. Tesseract is a fork+run
// (100ms–2.5s per call) and the preprocess is deterministic, so re-reading
// an unchanged screen — the follow-up submit loop, a re-painted selection
// rect, a scene pass over the same window — is free on a hit. Only
// successful reads are cached (an error may be transient); errors and the
// empty-input guard always re-run. Bounded LRU: Map keeps insertion order,
// so re-inserting on read evicts correctly.
const OCR_CACHE_MAX = 12;
const ocrCache = new Map<string, string>();

function ocrCacheGet(key: string): string | undefined {
  const hit = ocrCache.get(key);
  if (hit === undefined) return undefined;
  ocrCache.delete(key);
  ocrCache.set(key, hit);
  return hit;
}

function ocrCacheSet(key: string, text: string): void {
  ocrCache.set(key, text);
  while (ocrCache.size > OCR_CACHE_MAX) {
    const oldest = ocrCache.keys().next().value;
    if (oldest === undefined) break;
    ocrCache.delete(oldest);
  }
}

// Tests / shutdown hygiene.
export function clearOcrCache(): void {
  ocrCache.clear();
}

// Preprocess an image for OCR: grayscale, contrast boost, and 2x upscale
// for small crops. Uses Electron's nativeImage (Skia) — no extra deps.
function preprocessForOcr(b64: string): Buffer {
  const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
  const { width, height } = img.getSize();

  // Grayscale + contrast boost via simple pixel manipulation.
  // nativeImage gives us raw RGBA bitmap — we can work it directly.
  let bitmap = img.toBitmap();

  // If the crop is small (< 300px on longest edge), upscale 2x so Tesseract
  // has more pixels to work with on small UI text.
  let processed = img;
  const maxDim = Math.max(width, height);
  if (maxDim < 300 && maxDim > 0) {
    const scale = Math.min(2, Math.ceil(300 / maxDim));
    processed = nativeImage.createFromBuffer(bitmap, {
      width,
      height,
    }).resize({
      width: width * scale,
      height: height * scale,
      quality: 'best',
    });
  }

  // Convert to grayscale and boost contrast: iterate raw RGBA pixels and
  // apply a simple stretch-contrast on the luminance channel.
  bitmap = processed.toBitmap();
  const { width: w, height: h } = processed.getSize();
  // Grayscale: convert RGBA to luminance, then apply contrast stretch.
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < bitmap.length; i += 4, j++) {
    // Rec. 601 luma
    gray[j] = (0.299 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i + 2]) | 0;
  }
  // Compute histogram for contrast stretch (clip bottom/top 1%)
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let lo = 0, hi = 255;
  let cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum / total > 0.01) { lo = v; break; } }
  cum = 0;
  for (let v = 255; v >= 0; v--) { cum += hist[v]; if (cum / total > 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  // Apply contrast stretch back into the RGBA bitmap (grayscale output)
  for (let i = 0, j = 0; i < bitmap.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, ((gray[j] - lo) / range) * 255)) | 0;
    bitmap[i] = v;
    bitmap[i + 1] = v;
    bitmap[i + 2] = v;
  }
  // Return as PNG buffer
  const result = nativeImage.createFromBuffer(bitmap, { width: w, height: h });
  return result.toPNG();
}

// Shared Tesseract flags: LSTM engine + preserve spacing + 2-thread cap.
const TESS_FLAGS = ['--oem', '1', '-c', 'preserve_interword_spaces=1'];
const TESS_ENV = {
  ...process.env,
  OMP_THREAD_LIMIT: '2',
  OMP_NUM_THREADS: '2',
};
const TESS_OPTS = { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: TESS_ENV };

async function runTesseractOnB64(b64: string): Promise<{ text: string; error?: string }> {
  const tesseract = getTesseractPath();
  if (!tesseract) {
    return { text: '', error: 'OCR unavailable (Tesseract not installed)' };
  }
  if (!b64) return { text: '', error: 'OCR input is empty' };

  const cacheKey = frameHash(b64);
  const cached = ocrCacheGet(cacheKey);
  if (cached !== undefined) return { text: cached };

  const tmpFile = join(
    tmpdir(),
    `spirit-paint-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );
  try {
    const pngBuf = preprocessForOcr(b64);
    await writeFile(tmpFile, pngBuf);
    const clean = (raw: string) =>
      raw
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();

    const runPsm = async (psm: string): Promise<string> => {
      const { stdout } = await execFileP(
        tesseract,
        [tmpFile, 'stdout', '-l', 'eng', ...TESS_FLAGS, '--psm', psm],
        TESS_OPTS,
      );
      return clean(stdout);
    };

    let text = await runPsm('6');
    if (!text) text = await runPsm('11');
    // Cache the read (including a legitimately empty one): the finally
    // block still removes the temp file either way.
    ocrCacheSet(cacheKey, text);
    return { text };
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : 'OCR failed' };
  } finally {
    try {
      await rm(tmpFile, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export async function ocrRegionText(
  rect: { x: number; y: number; width: number; height: number },
  displayId: number,
): Promise<{ text: string; error?: string }> {
  if (rect.width < 4 || rect.height < 4) {
    return { text: '', error: 'Region too small to read' };
  }

  let b64: string;
  try {
    b64 = await captureRectFromDisplay(rect, displayId);
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : 'Region capture failed' };
  }
  if (!b64) return { text: '', error: 'Region capture returned empty' };

  return runTesseractOnB64(b64);
}

// OCR an already-captured image (JPEG base64, e.g. the auto-trigger
// screenshot). Lets the app read screen text for text-only models that can't
// see the attached image. Best-effort: missing tesseract or a bad read yields
// an empty text, never a throw.
export async function ocrImageB64Text(b64: string): Promise<string> {
  const res = await runTesseractOnB64(b64);
  return res.text;
}

// Cap for screen-text readbacks sent to the LLM (whole-screen OCR can be a
// wall of text that blows a small local model's context). Applied to the
// submit-time fresh OCR so a terminal log can't drown the visible app.
export const OCR_TEXT_CHAR_CAP = 2000;

export function capOcrText(text: string): string {
  if (!text) return '';
  return text.length > OCR_TEXT_CHAR_CAP ? text.slice(0, OCR_TEXT_CHAR_CAP) : text;
}
