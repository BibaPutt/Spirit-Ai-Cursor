import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'Spirit',
    getVersion: () => 'test',
    getPath: () => tmpdir(),
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('../electron/store/settings', () => ({
  getWorkspaceFolder: () => tmpdir(),
}));
import {
  attachedImages,
  attachedTextBlock,
  ATTACH_MAX_FILES,
  classifyAttachPath,
  mimeForExt,
  readAttachedFile,
  readAttachedFiles,
} from '../electron/files/attach';

function tmpFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'spirit-attach-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('classifyAttachPath', () => {
  it('sees images, text, missing and dirs', () => {
    const img = tmpFile('a.png', Buffer.from([137, 80, 78, 71]));
    const txt = tmpFile('b.txt', 'hi');
    expect(classifyAttachPath(img)).toBe('image');
    expect(classifyAttachPath(txt)).toBe('text');
    expect(classifyAttachPath(txt + '.nope')).toBe('missing');
    expect(classifyAttachPath(tmpdir())).toBe('dir');
  });
});

describe('readAttachedFile', () => {
  it('reads text and caps long files', () => {
    const p = tmpFile('long.txt', 'x'.repeat(30_000));
    const it = readAttachedFile(p);
    expect(it.kind).toBe('text');
    expect(it.text?.length).toBeLessThanOrEqual(20_000);
    expect(it.truncated).toBe(true);
  });

  it('refuses binary as text', () => {
    const p = tmpFile('bin.dat', Buffer.from([0, 1, 2, 3]));
    expect(readAttachedFile(p).kind).toBe('skipped');
  });

  it('reads small images as base64', () => {
    const p = tmpFile('i.png', Buffer.alloc(100, 7));
    const it = readAttachedFile(p);
    expect(it.kind).toBe('image');
    expect(typeof it.imageB64).toBe('string');
  });

  it('skips oversize images with a compress hint', () => {
    const p = tmpFile('big.png', Buffer.alloc(9 * 1024 * 1024, 7));
    const it = readAttachedFile(p);
    expect(it.kind).toBe('skipped');
    expect(it.note).toMatch(/compress/i);
  });
});

describe('readAttachedFiles', () => {
  it('caps file count with a trailing note', () => {
    const paths = Array.from({ length: ATTACH_MAX_FILES + 2 }, (_, i) => tmpFile(`f${i}.txt`, 'x'));
    const out = readAttachedFiles(paths);
    expect(out.length).toBe(ATTACH_MAX_FILES + 1);
    expect(out[out.length - 1].note).toMatch(/first 5/i);
  });

  it('never throws on garbage input', () => {
    expect(readAttachedFiles(['', '\0'])).toHaveLength(2);
  });
});

describe('attachedTextBlock / attachedImages / mimeForExt', () => {
  it('renders text inline and notes skips', () => {
    const block = attachedTextBlock([
      { path: 'a.txt', kind: 'text', text: 'hello' },
      { path: 'b.bin', kind: 'skipped', note: 'binary' },
    ]);
    expect(block).toContain('### a.txt');
    expect(block).toContain('hello');
    expect(block).toContain('binary');
    expect(attachedTextBlock([])).toBe('');
  });

  it('filters images and maps mime types', () => {
    const items = [
      { path: 'a.png', kind: 'image' as const, imageB64: 'AAA' },
      { path: 'b.txt', kind: 'text' as const, text: 'x' },
    ];
    expect(attachedImages(items)).toHaveLength(1);
    expect(mimeForExt('a.png')).toBe('image/png');
    expect(mimeForExt('a.webp')).toBe('image/webp');
    expect(mimeForExt('a.jpg')).toBe('image/jpeg');
  });
});
