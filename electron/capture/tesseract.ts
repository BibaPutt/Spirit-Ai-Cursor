// Cross-platform tesseract discovery. Pure node:fs/path only, no Electron
// imports, so vitest can test it directly. Every OCR path (paint-to-select,
// scene OCR, see_screen readback) resolves the binary through here — Windows
// keeps its historic install-path constant as the first candidate, mac/linux
// find it in the usual brew/apt locations or anywhere on PATH.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Candidate install paths, most likely first, per platform. On Windows the
// first entry is byte-identical to the hardcoded path the app has always
// used, so existing installs keep working exactly as before.
export function tesseractPathCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
      'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    ];
  }
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin/tesseract',
      '/usr/local/bin/tesseract',
      '/usr/bin/tesseract',
    ];
  }
  return ['/usr/bin/tesseract', '/usr/local/bin/tesseract'];
}

// Resolve the tesseract binary for the current platform, or null when none
// could be found. An explicit SPIRIT_TESSERACT_PATH env var always wins (lets
// a user point at a Homebrew/conda/other install).
//
// Memoized: every OCR call (paint-to-select, scene text, submit readback)
// resolves through here, and the scan stat()s up to two install candidates
// plus every PATH entry — dozens of syscalls per OCR pass for a result that
// never changes mid-session. Positive hits live for 30s (a user who installs
// tesseract while the app runs is picked up on the next miss); negative
// results are retried after 5s so "OCR unavailable" heals without a restart.
const POSITIVE_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 5_000;
let cachedPath: string | null = null;
let cachedAt = 0;

export function resetTesseractPathCache(): void {
  cachedPath = null;
  cachedAt = 0;
}

export function getTesseractPath(): string | null {
  const env = process.env.SPIRIT_TESSERACT_PATH?.trim();
  if (env) return env;
  const now = Date.now();
  if (cachedPath !== null && now - cachedAt < POSITIVE_TTL_MS) return cachedPath;
  if (cachedPath === null && now - cachedAt < NEGATIVE_TTL_MS && cachedAt !== 0) return null;
  let found: string | null = null;
  for (const p of tesseractPathCandidates(process.platform)) {
    if (existsSync(p)) {
      found = p;
      break;
    }
  }
  if (!found) {
    // PATH fallback (e.g. tesseract in ~/.local/bin or an env-managed install).
    const name = process.platform === 'win32' ? 'tesseract.exe' : 'tesseract';
    const sep = process.platform === 'win32' ? ';' : ':';
    for (const dir of (process.env.PATH ?? '').split(sep)) {
      const d = dir.trim();
      if (!d) continue;
      const p = join(d, name);
      if (existsSync(p)) {
        found = p;
        break;
      }
    }
  }
  cachedPath = found;
  cachedAt = now;
  return cachedPath;
}
