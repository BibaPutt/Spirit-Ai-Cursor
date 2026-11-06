import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { resolveFilePath } from '../llm/tools/read-file';

// Dropped-file attach: files the user drags onto the prompt box, read into
// the turn context (text inline, images as vision blocks). Same caps and
// traversal rules as read_file. Directories and missing paths are skipped
// with a note (never throw — the turn must survive a bad drop).

export const ATTACH_MAX_FILES = 5;
export const ATTACH_MAX_TEXT = 20_000;
export const ATTACH_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export type AttachedItemKind = 'text' | 'image' | 'skipped';

export interface AttachedItem {
  path: string;
  kind: AttachedItemKind;
  // Text content (capped) for text files.
  text?: string;
  truncated?: boolean;
  // Raw bytes (base64) for images; the submit path sniffs the mime from ext.
  imageB64?: string;
  // Human note for skipped entries (missing, dir, too big, binary).
  note?: string;
}

export function classifyAttachPath(path: string): AttachedItemKind | 'missing' | 'dir' {
  if (!existsSync(path)) return 'missing';
  try {
    if (statSync(path).isDirectory()) return 'dir';
  } catch {
    return 'missing';
  }
  return IMAGE_EXTS.has(extname(path).toLowerCase()) ? 'image' : 'text';
}

export function readAttachedFile(absPath: string): AttachedItem {
  const kind = classifyAttachPath(absPath);
  if (kind === 'missing') return { path: absPath, kind: 'skipped', note: 'does not exist' };
  if (kind === 'dir') return { path: absPath, kind: 'skipped', note: 'is a directory — use list_dir' };
  let size = 0;
  try {
    size = statSync(absPath).size;
  } catch {
    return { path: absPath, kind: 'skipped', note: 'unreadable' };
  }
  if (kind === 'image') {
    if (size > ATTACH_MAX_IMAGE_BYTES) {
      return { path: absPath, kind: 'skipped', note: `image too big (${size} bytes) — use compress_file first` };
    }
    try {
      return { path: absPath, kind: 'image', imageB64: readFileSync(absPath).toString('base64') };
    } catch {
      return { path: absPath, kind: 'skipped', note: 'unreadable' };
    }
  }
  try {
    const buf = readFileSync(absPath);
    if (buf.includes(0)) return { path: absPath, kind: 'skipped', note: 'binary — not readable as text' };
    const text = buf.toString('utf-8');
    if (text.length > ATTACH_MAX_TEXT) {
      return {
        path: absPath,
        kind: 'text',
        text: text.slice(0, ATTACH_MAX_TEXT),
        truncated: true,
      };
    }
    return { path: absPath, kind: 'text', text };
  } catch {
    return { path: absPath, kind: 'skipped', note: 'unreadable' };
  }
}

// Resolve + read a dropped path list. Relative paths resolve in the
// workspace (same rule as read_file); absolute paths anywhere. Caps at
// ATTACH_MAX_FILES with a trailing skipped note.
export function readAttachedFiles(paths: string[]): AttachedItem[] {
  const out: AttachedItem[] = [];
  for (const raw of paths.slice(0, ATTACH_MAX_FILES)) {
    let abs: string;
    try {
      abs = resolveFilePath(raw);
    } catch {
      out.push({ path: String(raw), kind: 'skipped', note: 'invalid path' });
      continue;
    }
    out.push(readAttachedFile(abs));
  }
  if (paths.length > ATTACH_MAX_FILES) {
    out.push({
      path: '',
      kind: 'skipped',
      note: `only the first ${ATTACH_MAX_FILES} files were attached`,
    });
  }
  return out;
}

// Text block for the turn context (text files inline; skips noted).
export function attachedTextBlock(items: AttachedItem[]): string {
  const parts: string[] = [];
  for (const it of items) {
    if (it.kind === 'text' && it.text !== undefined) {
      parts.push(`### ${it.path}\n${it.text}${it.truncated ? '\n…[truncated — ask for more with read_file]' : ''}`);
    } else if (it.kind === 'skipped' && it.path) {
      parts.push(`### ${it.path}\n(skipped: ${it.note ?? 'unknown'})`);
    } else if (it.kind === 'skipped') {
      parts.push(`(${it.note ?? 'skipped'})`);
    }
  }
  if (parts.length === 0) return '';
  return `Attached files:\n${parts.join('\n\n')}`;
}

export function attachedImages(items: AttachedItem[]): AttachedItem[] {
  return items.filter((it) => it.kind === 'image' && it.imageB64);
}

export function mimeForExt(path: string): string {  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.webp':
      return 'image/webp';
    case '.jpg':
    case '.jpeg':
    default:
      return 'image/jpeg';
  }
}