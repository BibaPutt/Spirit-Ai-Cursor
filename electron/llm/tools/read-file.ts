import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { getWorkspaceFolder } from '../../store/settings';
import {
  buildPdfToolProbe,
  buildReadDocxPs,
  buildReadPdfPs,
  buildReadXlsxPs,
  defaultPsRunner,
} from '../../files/office';import type { ToolDefinition } from './index';

export const READ_MAX_CHARS = 100_000;

// Shared resolver: absolute anywhere; relative stays inside the workspace.
export function resolveFilePath(requested: string): string {
  const clean = String(requested ?? '').trim();
  if (!clean) throw new Error('empty path');
  if (isAbsolute(clean)) return resolve(clean);
  const workspace = getWorkspaceFolder();
  const target = resolve(workspace, clean);
  const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;
  if (target !== workspace && !target.startsWith(prefix)) {
    throw new Error('path escapes the Spirit workspace; pass an absolute path to read elsewhere');
  }
  return target;
}

export function sliceText(text: string, maxChars: number, offsetChars = 0): { slice: string; truncated: boolean; total: number } {
  const total = text.length;
  const slice = text.slice(offsetChars, offsetChars + maxChars);
  return { slice, truncated: offsetChars + maxChars < total, total };
}

function pagingArgs(args: Record<string, unknown>): { maxChars: number; offsetChars: number } {
  return {
    maxChars: Math.max(1000, Math.min(READ_MAX_CHARS, Math.floor(Number(args.maxChars) || 20000))),
    offsetChars: Math.max(0, Math.floor(Number(args.offsetChars) || 0)),
  };
}

function pagedResult(target: string, text: string, args: Record<string, unknown>): string {
  const { maxChars, offsetChars } = pagingArgs(args);
  const { slice, truncated, total } = sliceText(text, maxChars, offsetChars);
  const tail = truncated
    ? `\n…[truncated ${total} chars total — call read_file again with offsetChars ${offsetChars + maxChars}]`
    : '';
  return `File ${target} (${total} chars):\n${slice}${tail}`;
}

// Office/PDF dispatch. Returns null when this path doesn't apply (non-Windows
// or other extensions) so the caller falls through to the plain text read.
// Otherwise {ok, text} or {ok:false, error} with a free-endpoint fallback.
async function readOfficeOrPdf(
  target: string,
  ext: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string } | null> {
  try {
    if (ext === '.docx') {
      const { stdout } = await defaultPsRunner(buildReadDocxPs(target));
      const text = stdout.trim();
      if (!text) {
        return {
          ok: false,
          error: `Error: no text extracted from ${target} (empty or unreadable document). Try open_file to view it, or a free web endpoint.`,
        };
      }
      return { ok: true, text };
    }
    if (ext === '.xlsx') {
      const { stdout } = await defaultPsRunner(buildReadXlsxPs(target));
      const text = stdout.trim();
      if (!text) {
        return {
          ok: false,
          error: `Error: no text extracted from ${target} (empty or unreadable workbook). Try open_file to view it, or a free web endpoint.`,
        };
      }
      return { ok: true, text };
    }
    if (ext === '.pdf') {
      const probe = await defaultPsRunner(buildPdfToolProbe());
      if (!probe.stdout.trim().toLowerCase().startsWith('yes')) {
        return {
          ok: false,
          error: `Error: ${target} is a PDF and pdftotext is not installed — I cannot read it locally. Open it with open_file and read via see_screen, or use a free web endpoint (e.g. ilovepdf).`,
        };
      }
      const { stdout } = await defaultPsRunner(buildReadPdfPs(target));
      const text = stdout.trim();
      if (!text) {
        return {
          ok: false,
          error: `Error: no text layer in ${target} (scanned PDF?). Try open_file + see_screen to read it visually, or a free OCR web endpoint.`,
        };
      }
      return { ok: true, text };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Error: could not parse ${target} locally (${err instanceof Error ? err.message : String(err)}). Try open_file to view it, or a free web endpoint.`,
    };
  }
  return null;
}

export const readFileTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file INTO this conversation (view inside, summarize, quote). Text files directly (capped, paged); .docx/.xlsx parsed locally without Office; .pdf via pdftotext when installed (scanned PDFs fall back to open_file + see_screen). Relative = workspace folder; absolute = exact location. Binary unknowns are refused with a fallback pointer.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read.' },
          maxChars: { type: 'number', description: 'Max characters to return (default 20000, hard cap 100000).' },
          offsetChars: { type: 'number', description: 'Start offset for paging through big files.' },
        },
        required: ['path'],
      },
    },
  },
  uiLabel: (args) => {
    const p = String(args.path ?? '').trim();
    return p ? `Reading file: ${p.slice(0, 40)}` : 'Reading file';
  },
  async execute(args) {
    let target: string;
    try {
      target = resolveFilePath(String(args.path ?? ''));
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!existsSync(target)) return `Error: file does not exist: ${target}.`;
    // Office/PDF formats: unzip-and-parse locally (no Office install needed
    // for docx/xlsx; pdftotext when poppler is present). Falls back to free
    // web endpoints when the local path can't run.
    const ext = extname(target).toLowerCase();
    if (process.platform === 'win32' && (ext === '.docx' || ext === '.xlsx' || ext === '.pdf')) {
      const via = await readOfficeOrPdf(target, ext);
      if (via !== null) {
        if (via.ok) return pagedResult(target, via.text, args);
        return via.error;
      }
    }
    try {
      if (statSync(target).isDirectory()) {
        return `Error: ${target} is a directory — use list_dir to see inside.`;
      }
    } catch {
      /* fall through to read attempt */
    }
    const maxChars = Math.max(
      1000,
      Math.min(READ_MAX_CHARS, Math.floor(Number(args.maxChars) || 20000)),
    );
    const offsetChars = Math.max(0, Math.floor(Number(args.offsetChars) || 0));
    let text: string;
    try {
      const buf = readFileSync(target);
      if (buf.includes(0)) {
        return `Error: ${target} looks binary — read_file is text-only. Use compress_file for images.`;
      }
      text = buf.toString('utf-8');
    } catch (err) {
      return `Error: cannot read ${target} (${err instanceof Error ? err.message : String(err)}).`;
    }
    const { slice, truncated, total } = sliceText(text, maxChars, offsetChars);
    const tail = truncated
      ? `\n…[truncated ${total} chars total — call read_file again with offsetChars ${offsetChars + maxChars}]`
      : '';
    return `File ${target} (${total} chars):\n${slice}${tail}`;
  },
};
