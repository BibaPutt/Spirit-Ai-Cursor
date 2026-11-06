import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { basename, dirname, extname, join } from 'node:path';
import { resolveFilePath } from './read-file';
import { buildFfmpegProbe, defaultPsRunner } from '../../files/office';
import type { ToolDefinition } from './index';

const execFileP = promisify(execFile);

export const COMPRESS_MAX_DIM = 1280;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.aac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi']);

export function isCompressibleImage(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase());
}

export function compressedName(path: string): string {
  const dir = dirname(path);
  const base = basename(path, extname(path));
  return join(dir, `${base}.small.jpg`);
}

// Shrink an image (resize longest edge + JPEG re-encode) so it costs less
// to store/send. Writes a NEW file (`name.small.jpg`) by default; pass
// overwrite:true to replace in place. Script-first, self-contained: when
// this tool can't run (or the file isn't an image), the model falls back to
// run_command, then a free web endpoint — never just gives up. Reversible
// (new file) → approval-free like save_document.
export const compressFileTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'compress_file',
      description:
        'Shrink a file IN PLACE-FORMAT like online tools do (same type, smaller): images → smaller JPEG (longest edge capped, default 1280px, quality 80; writes name.small.jpg unless overwrite:true); PDF → compressed PDF via local Ghostscript when present; audio → lower bitrate MP3; video → smaller MP4. When no local path exists, the error names a free web endpoint (e.g. ilovepdf, iloveimg) — never just give up.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Image file to shrink.' },
          maxDim: { type: 'number', description: 'Longest-edge cap in px (default 1280).' },
          quality: { type: 'number', description: 'JPEG quality 1-100 (default 80).' },
          overwrite: { type: 'boolean', description: 'Replace the original instead of writing .small.jpg.' },
        },
        required: ['path'],
      },
    },
  },
  uiLabel: (args) => {
    const p = String(args.path ?? '').trim();
    return p ? `Compressing: ${p.slice(0, 40)}` : 'Compressing file';
  },
  async execute(args) {
    let target: string;
    try {
      target = resolveFilePath(String(args.path ?? ''));
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!existsSync(target)) return `Error: file does not exist: ${target}.`;
    const ext = extname(target).toLowerCase();
    // PDF: same-format shrink via Ghostscript (ebook preset). No Ghostscript
    // → free web endpoint (ilovepdf compress, free, no signup).
    if (ext === '.pdf') return compressPdf(target, args.overwrite === true);
    if (AUDIO_EXTS.has(ext)) return compressAudio(target, args.overwrite === true);
    if (VIDEO_EXTS.has(ext)) return compressVideo(target, args.overwrite === true);
    if (!isCompressibleImage(target)) {
      return (
        `Error: ${target} is not shrinkable here (images, PDF with Ghostscript, audio/video with ffmpeg). ` +
        'Try a run_command script, or a free web endpoint (ilovepdf/iloveimg) — do not give up.'
      );
    }
    const maxDim = Math.max(16, Math.min(8192, Math.floor(Number(args.maxDim) || COMPRESS_MAX_DIM)));
    const quality = Math.max(1, Math.min(100, Math.floor(Number(args.quality) || 80)));
    const out = args.overwrite === true ? target : compressedName(target);
    let before = 0;
    try {
      before = statSync(target).size;
      await sharp(target, { animated: false })
        .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toFile(out);
      const after = statSync(out).size;
      const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      return `Compressed ${target} (${formatSize(before)}) → ${out} (${formatSize(after)}, ${pct}% smaller).`;
    } catch (err) {
      return `Error: cannot compress ${target} (${err instanceof Error ? err.message : String(err)}). Try a run_command script, or a free web endpoint — do not give up.`;
    }
  },
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function compressPdf(target: string, overwrite: boolean): Promise<string> {
  const hasGs = await ghostscriptOk();
  if (!hasGs) {
    return `Error: ${target} needs Ghostscript to shrink, which is not installed — use the free ilovepdf compress endpoint (no signup), or install Ghostscript.`;
  }
  const out = overwrite ? `${target}.tmp.pdf` : target.replace(/\.pdf$/i, '') + '.small.pdf';
  try {
    const before = statSync(target).size;
    const gs = process.platform === 'win32' ? 'gswin64c' : 'gs';
    const args = [
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dPDFSETTINGS=/ebook',
      '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${out}`, target,
    ];
    if (process.platform === 'win32') {
      const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
      await defaultPsRunner(`& ${gs} ${args.map((a) => (a.includes(' ') ? q(a) : a)).join(' ')}`);
    } else {
      await execFileP(gs, args, { timeout: 300_000, windowsHide: true });
    }
    if (overwrite) {
      try {
        unlinkSync(target);
      } catch {
        /* already replaced */
      }
      renameSync(out, target);
      return `Compressed ${target} (${formatSize(before)}) → same file (${formatSize(statSync(target).size)}).`;
    }
    const after = statSync(out).size;
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    return `Compressed ${target} (${formatSize(before)}) → ${out} (${formatSize(after)}, ${pct}% smaller).`;
  } catch (err) {
    return `Error: cannot compress ${target} (${err instanceof Error ? err.message : String(err)}). Try the free ilovepdf compress endpoint — do not give up.`;
  }
}

async function ghostscriptOk(): Promise<boolean> {
  const bin = process.platform === 'win32' ? 'gswin64c' : 'gs';
  if (process.platform === 'win32') {
    try {
      const { stdout } = await defaultPsRunner(
        `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
      );
      return stdout.trim().toLowerCase().startsWith('yes');
    } catch {
      return false;
    }
  }
  try {
    await execFileP(bin, ['--version'], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function ffmpegOk(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await defaultPsRunner(buildFfmpegProbe());
      return stdout.trim().toLowerCase().startsWith('yes');
    } catch {
      return false;
    }
  }
  try {
    await execFileP('ffmpeg', ['-version'], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function compressAudio(target: string, overwrite: boolean): Promise<string> {
  if (!(await ffmpegOk())) {
    return `Error: ${target} needs ffmpeg to shrink, which is not installed — use a free web endpoint (e.g. veed.io free tier, iloveimg audio tools), or install ffmpeg.`;
  }
  const out = overwrite ? target : target.replace(/\.[^.]+$/, '') + '.small.mp3';
  try {
    const before = statSync(target).size;
    if (process.platform === 'win32') {
      await defaultPsRunner(
        `ffmpeg -y -i '${target.replace(/'/g, "''")}' -b:a 64k -ar 16000 -ac 1 '${out.replace(/'/g, "''")}'`,
      );
    } else {
      await execFileP('ffmpeg', ['-y', '-i', target, '-b:a', '64k', '-ar', '16000', '-ac', '1', out], {
        timeout: 120_000,
        windowsHide: true,
      });
    }
    const after = statSync(out).size;
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    return `Compressed ${target} (${formatSize(before)}) → ${out} (${formatSize(after)}, ${pct}% smaller).`;
  } catch (err) {
    return `Error: cannot compress ${target} (${err instanceof Error ? err.message : String(err)}). Try a free web endpoint — do not give up.`;
  }
}

async function compressVideo(target: string, overwrite: boolean): Promise<string> {
  if (!(await ffmpegOk())) {
    return `Error: ${target} needs ffmpeg to shrink, which is not installed — use a free web endpoint (e.g. iloveimg video tools), or install ffmpeg.`;
  }
  const out = overwrite ? target : target.replace(/\.[^.]+$/, '') + '.small.mp4';
  try {
    const before = statSync(target).size;
    const args = ['-y', '-i', target, '-vf', 'scale=1280:-1', '-crf', '28', '-preset', 'veryfast', '-b:a', '64k', out];
    if (process.platform === 'win32') {
      const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
      await defaultPsRunner(`ffmpeg ${args.map((a) => (a.includes(' ') || a.includes(':') ? q(a) : a)).join(' ')}`);
    } else {
      await execFileP('ffmpeg', args, { timeout: 300_000, windowsHide: true });
    }
    const after = statSync(out).size;
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    return `Compressed ${target} (${formatSize(before)}) → ${out} (${formatSize(after)}, ${pct}% smaller).`;
  } catch (err) {
    return `Error: cannot compress ${target} (${err instanceof Error ? err.message : String(err)}). Try a free web endpoint — do not give up.`;
  }
}
