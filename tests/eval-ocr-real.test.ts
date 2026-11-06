// REAL OCR accuracy evaluation — no mocks for the OCR engine itself.
//
// What this does:
//  - Renders REAL rasterized text images (sharp SVG -> PNG) with KNOWN
//    ground-truth strings across font sizes (small <12pt, normal, large).
//  - Runs the REAL tesseract binary resolved via the production discovery
//    function (getTesseractPath from electron/capture/tesseract.ts) with the
//    EXACT flags ocr.ts uses: --oem 1 (LSTM), preserve_interword_spaces=1,
//    PSM 6 primary with PSM 11 fallback on empty output.
//  - Computes REAL WER/CER (Levenshtein) + per-case latency + PSM fallback
//    rate, prints a table to stdout, and FAILS honestly when the binary is
//    missing or accuracy is bad.
//
// Why not import ocr.ts directly: it depends on Electron's nativeImage
// (unavailable under vitest). The small-crop 2x upscale step from ocr.ts is
// mirrored here with sharp so the pipeline stays faithful.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  getTesseractPath,
  tesseractPathCandidates,
} from '../electron/capture/tesseract';

const execFileP = promisify(execFile);

// Ground-truth fixtures: [name, lines, fontPx, sizeBucket]
// 12pt @ 96dpi ~= 16px, so "small" (<12pt) uses 13-14px.
type Fixture = { name: string; lines: string[]; fontPx: number; bucket: 'small' | 'normal' | 'large' };

const FIXTURES: Fixture[] = [
  { name: 'normal-sentence-32', lines: ['The quick brown fox jumps over the lazy dog'], fontPx: 32, bucket: 'normal' },
  { name: 'large-sentence-64', lines: ['Pack my box with five dozen liquor jugs'], fontPx: 64, bucket: 'large' },
  { name: 'digits-40', lines: ['1234567890'], fontPx: 40, bucket: 'normal' },
  { name: 'multiline-28', lines: ['Hello world', 'Vitest OCR evaluation'], fontPx: 28, bucket: 'normal' },
  { name: 'small-sentence-14', lines: ['The quick brown fox jumps'], fontPx: 14, bucket: 'small' },
  { name: 'small-digits-13', lines: ['9876543210'], fontPx: 13, bucket: 'small' },
];

// Helpers
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render clean black-on-white text PNG (real rasterized glyphs, not stubs).
async function renderTextPng(fx: Fixture): Promise<Buffer> {
  const pad = Math.ceil(fx.fontPx * 1.2);
  const longest = Math.max(...fx.lines.map((l) => l.length));
  // Arial avg advance ~0.55-0.6em; 0.7 factor leaves headroom so nothing clips.
  const width = Math.max(400, Math.ceil(longest * fx.fontPx * 0.7) + pad * 2);
  const height = fx.lines.length * Math.ceil(fx.fontPx * 1.9) + pad * 2;
  const texts = fx.lines
    .map(
      (l, i) =>
        `<text x="${pad}" y="${pad + fx.fontPx + i * Math.ceil(fx.fontPx * 1.9)}" font-family="Arial, Helvetica, sans-serif" font-size="${fx.fontPx}px" fill="black">${escapeXml(l)}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${texts}</svg>`;
  let png = sharp(Buffer.from(svg));
  // Mirror ocr.ts: 2x upscale when longest edge < 300px (small-crop path).
  const meta = await png.metadata();
  const maxDim = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (maxDim < 300 && maxDim > 0) {
    const scale = Math.min(2, Math.ceil(300 / maxDim));
    png = png.resize((meta.width ?? 0) * scale, (meta.height ?? 0) * scale, { kernel: 'lanczos3' });
  }
  return png.png().toBuffer();
}

// Same cleanup as ocr.ts: CRLF -> LF, collapse spaces, trim.
function cleanOcr(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Whitespace-only normalization (case-sensitive: honest, no score inflation).
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cer(ref: string, hyp: string): number {
  const r = norm(ref);
  const h = norm(hyp);
  if (!r) return h ? 1 : 0;
  return levenshtein(r, h) / r.length;
}

function wer(ref: string, hyp: string): number {
  const r = norm(ref).split(' ').filter(Boolean);
  const h = norm(hyp).split(' ').filter(Boolean);
  if (!r.length) return h.length ? 1 : 0;
  return levenshtein(r.join('\n'), h.join('\n')) === 0
    ? 0
    : levenshteinWords(r, h) / r.length;
}

function levenshteinWords(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

type OcrOutcome = { text: string; psmUsed: string; fellBack: boolean; latencyMs: number };

// Run REAL tesseract with ocr.ts's exact flags. PSM 6, fallback to 11 on empty.
async function runRealOcr(tesseract: string, png: Buffer, dir: string, tag: string): Promise<OcrOutcome> {
  const file = join(dir, `eval-${tag}.png`);
  await writeFile(file, png);
  const flags = ['--oem', '1', '-c', 'preserve_interword_spaces=1'];
  const env = { ...process.env, OMP_THREAD_LIMIT: '2', OMP_NUM_THREADS: '2' };
  const opts = { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env };
  const t0 = performance.now();
  const { stdout: out6 } = await execFileP(tesseract, [file, 'stdout', '-l', 'eng', ...flags, '--psm', '6'], opts);
  let text = cleanOcr(out6);
  let psmUsed = '6';
  let fellBack = false;
  if (!text) {
    const { stdout: out11 } = await execFileP(tesseract, [file, 'stdout', '-l', 'eng', ...flags, '--psm', '11'], opts);
    text = cleanOcr(out11);
    psmUsed = '11';
    fellBack = true;
  }
  return { text, psmUsed, fellBack, latencyMs: performance.now() - t0 };
}

// Tests
describe('real OCR accuracy evaluation', () => {
  it('resolves tesseract via production discovery (win32 keeps historic path first)', () => {
    expect(tesseractPathCandidates('win32')[0]).toBe('C:\\Program Files\\Tesseract-OCR\\tesseract.exe');
    const p = getTesseractPath();
    // Honest hard fail when the engine is absent: nothing here can be measured.
    expect(p, `Tesseract not found. Candidates: ${tesseractPathCandidates(process.platform).join(', ')}`).toBeTruthy();
  });

  it('reads rendered ground-truth images with measured WER/CER', async () => {
    const tesseract = getTesseractPath();
    expect(tesseract, 'Tesseract binary missing — cannot evaluate OCR').toBeTruthy();
    const dir = await mkdtemp(join(tmpdir(), 'spirit-ocr-eval-'));
    try {
      const rows: {
        name: string;
        bucket: string;
        fontPx: number;
        ref: string;
        hyp: string;
        cer: number;
        wer: number;
        psm: string;
        fellBack: boolean;
        ms: number;
      }[] = [];
      for (const fx of FIXTURES) {
        const png = await renderTextPng(fx);
        const out = await runRealOcr(tesseract!, png, dir, fx.name);
        const ref = fx.lines.join('\n');
        rows.push({
          name: fx.name,
          bucket: fx.bucket,
          fontPx: fx.fontPx,
          ref,
          hyp: out.text,
          cer: cer(ref, out.text),
          wer: wer(ref, out.text),
          psm: out.psmUsed,
          fellBack: out.fellBack,
          ms: Math.round(out.latencyMs),
        });
      }

      // REAL numbers to stdout (no invented values)
      console.log('\n=== REAL OCR EVAL (tesseract ' + tesseract + ') ===');
      console.log('case                  bucket  px  CER     WER     PSM  fallback  ms   hyp');
      for (const r of rows) {
        console.log(
          `${r.name.padEnd(22)}${r.bucket.padEnd(8)}${String(r.fontPx).padEnd(4)}` +
            `${r.cer.toFixed(3).padEnd(8)}${r.wer.toFixed(3).padEnd(8)}${r.psm.padEnd(5)}` +
            `${(r.fellBack ? 'yes' : 'no').padEnd(10)}${String(r.ms).padEnd(5)}${JSON.stringify(r.hyp.slice(0, 60))}`,
        );
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const big = rows.filter((r) => r.bucket !== 'small');
      const small = rows.filter((r) => r.bucket === 'small');
      const fallbackRate = rows.filter((r) => r.fellBack).length / rows.length;
      console.log(
        `\nmean CER/WER (normal+large): ${mean(big.map((r) => r.cer)).toFixed(3)} / ${mean(big.map((r) => r.wer)).toFixed(3)}` +
          ` | mean CER/WER (small <12pt): ${mean(small.map((r) => r.cer)).toFixed(3)} / ${mean(small.map((r) => r.wer)).toFixed(3)}` +
          ` | PSM fallback rate: ${(fallbackRate * 100).toFixed(1)}% (${rows.filter((r) => r.fellBack).length}/${rows.length})` +
          ` | mean latency: ${Math.round(mean(rows.map((r) => r.ms)))}ms`,
      );

      // Honest assertions
      // Engine must actually read the easy cases: non-empty output required.
      for (const r of big) {
        expect(r.hyp, `${r.name}: OCR returned empty text`).not.toBe('');
      }
      // Accuracy bar on clean rendered text (whitespace-normalized, case-sensitive).
      expect(mean(big.map((r) => r.cer)), 'mean CER on normal+large text too high').toBeLessThan(0.2);
      expect(mean(big.map((r) => r.wer)), 'mean WER on normal+large text too high').toBeLessThan(0.35);
      // Small text is reported, not gated (known-hard); but total blindness fails.
      expect(small.some((r) => r.hyp.length > 0), 'OCR read NOTHING at small sizes').toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
