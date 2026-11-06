import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { createFileTool } from '../electron/llm/tools/create-file';
import { openFileTool } from '../electron/llm/tools/open-file';
import { readFileTool, sliceText } from '../electron/llm/tools/read-file';
import { editFileTool, applyEdit } from '../electron/llm/tools/edit-file';
import { listDirTool, formatBytes } from '../electron/llm/tools/list-dir';
import { compressFileTool, isCompressibleImage, compressedName } from '../electron/llm/tools/compress-file';

const hoisted = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  return {
    workspace: join(process.cwd(), '.tmp-tool-test-workspace'),
    openPath: vi.fn(async () => ''),
  };
});

vi.mock('electron', () => ({
  shell: { openPath: hoisted.openPath },
  app: { getPath: () => '', getName: () => '', getVersion: () => '', whenReady: () => Promise.resolve() },
}));

vi.mock('../electron/store/settings', () => ({
  getWorkspaceFolder: () => hoisted.workspace,
}));

const ctx = {
  latestAssistantText: '',
  originalPrompt: 'x',
  abort: new AbortController().signal,
} as never;

describe('create_file tool', () => {
  beforeEach(async () => {
    await fs.rm(hoisted.workspace, { recursive: true, force: true });
    hoisted.openPath.mockClear();
  });

  it('writes a relative path into the workspace and reports the absolute path', async () => {
    const res = await createFileTool.execute({ path: 'notes.md', content: '# hi' }, ctx);
    const expectPath = join(hoisted.workspace, 'notes.md');
    expect(res).toContain(expectPath);
    expect(await fs.readFile(expectPath, 'utf-8')).toBe('# hi');
    expect(hoisted.openPath).not.toHaveBeenCalled();
  });

  it('keeps the extension the model gives (regex-verified)', async () => {
    await createFileTool.execute({ path: 'deck.txt.html', content: '<html></html>' }, ctx);
    expect(await fs.readFile(join(hoisted.workspace, 'deck.txt.html'), 'utf-8')).toBe('<html></html>');
  });

  it('writes to an absolute path outside the workspace', async () => {
    const abs = join(hoisted.workspace, '..', 'abs-outside.md');
    const res = await createFileTool.execute({ path: abs, content: 'data' }, ctx);
    expect(res).toContain(abs);
    expect(await fs.readFile(abs, 'utf-8')).toBe('data');
    await fs.rm(abs, { force: true });
  });

  it('refuses a relative path that escapes the workspace', async () => {
    const res = await createFileTool.execute({ path: '../../evil.md', content: 'x' }, ctx);
    expect(res).toContain('Error');
    expect(res).toContain('workspace');
  });

  it('rejects binary content with a guidance error', async () => {
    const res = await createFileTool.execute({ path: 'deck.pptx', content: 'PK\x00\x03' }, ctx);
    expect(res).toContain('Error');
    expect(res).toContain('binary');
  });

  it('opens the file when open=true', async () => {
    await createFileTool.execute({ path: 'notes.md', content: '# hi', open: true }, ctx);
    expect(hoisted.openPath).toHaveBeenCalledTimes(1);
    expect(hoisted.openPath).toHaveBeenCalledWith(join(hoisted.workspace, 'notes.md'));
  });
});

describe('open_file tool', () => {
  beforeEach(async () => {
    await fs.mkdir(hoisted.workspace, { recursive: true });
    hoisted.openPath.mockClear();
  });

  it('resolves a relative path inside the workspace', async () => {
    await fs.writeFile(join(hoisted.workspace, 'app.html'), 'x');
    const res = await openFileTool.execute({ path: 'app.html' }, ctx);
    expect(res).toContain(join(hoisted.workspace, 'app.html'));
    expect(hoisted.openPath).toHaveBeenCalledWith(join(hoisted.workspace, 'app.html'));
  });

  it('tells the model to verify after opening', async () => {
    await fs.writeFile(join(hoisted.workspace, 'app.html'), 'x');
    const res = await openFileTool.execute({ path: 'app.html' }, ctx);
    expect(res).toContain('see_screen');
  });

  it('errors when the file does not exist', async () => {
    const res = await openFileTool.execute({ path: 'missing.html' }, ctx);
    expect(res).toContain('Error');
    expect(res).toContain('missing.html');
  });

  it('refuses a relative path escaping the workspace', async () => {
    const res = await openFileTool.execute({ path: '../outside.txt' }, ctx);
    expect(res).toContain('Error');
    expect(res).toContain('workspace');
  });
});

describe('read_file tool', () => {
  it('reads text with total + pages past the cap', async () => {
    await fs.writeFile(join(hoisted.workspace, 'notes.txt'), 'hello world');
    const res = await readFileTool.execute({ path: 'notes.txt' }, ctx);
    expect(res).toContain('hello world');
    expect(res).toContain('notes.txt');
  });

  it('refuses binary and missing files', async () => {
    await fs.writeFile(join(hoisted.workspace, 'b.bin'), Buffer.from([0, 1, 2]));
    expect(await readFileTool.execute({ path: 'b.bin' }, ctx)).toMatch(/binary/i);
    expect(await readFileTool.execute({ path: 'nope.txt' }, ctx)).toMatch(/does not exist/);
  });

  it('sliceText pages and flags truncation', () => {
    const r = sliceText('abcdefghij', 4, 4);
    expect(r.slice).toBe('efgh');
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(10);
  });
});

describe('edit_file tool', () => {
  it('replaces one exact block', async () => {
    await fs.writeFile(join(hoisted.workspace, 'e.txt'), 'line one\nline two\n');
    const res = await editFileTool.execute(
      { path: 'e.txt', oldText: 'line two', newText: 'line 2!' },
      ctx,
    );
    expect(res).toMatch(/replaced/i);
    expect(await fs.readFile(join(hoisted.workspace, 'e.txt'), 'utf-8')).toContain('line 2!');
  });

  it('refuses missing and ambiguous matches', () => {
    expect(applyEdit('aaa', 'zzz', 'b')).toMatchObject({ ok: false });
    expect(applyEdit('aaXXaa', 'aa', 'b')).toMatchObject({ ok: false });
    expect(applyEdit('hello world', 'world', 'there')).toMatchObject({ ok: true });
  });

  it('appends at the end', async () => {
    await fs.writeFile(join(hoisted.workspace, 'a.txt'), 'first');
    const res = await editFileTool.execute({ path: 'a.txt', newText: 'second', append: true }, ctx);
    expect(res).toMatch(/Appended/);
    expect(await fs.readFile(join(hoisted.workspace, 'a.txt'), 'utf-8')).toContain('second');
  });
});

describe('list_dir tool', () => {
  it('lists workspace entries with sizes', async () => {
    await fs.writeFile(join(hoisted.workspace, 'l.txt'), 'x');
    const res = await listDirTool.execute({}, ctx);
    expect(res).toContain('l.txt');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('rejects escaping paths', async () => {
    expect(await listDirTool.execute({ path: '../..' }, ctx)).toMatch(/workspace/i);
  });
});

describe('compress_file tool', () => {
  it('shrinks a png into a .small.jpg', async () => {
    const sharp = (await import('sharp')).default;
    const src = join(hoisted.workspace, 'big.png');
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 9, g: 99, b: 200 } } })
      .png()
      .toFile(src);
    const res = await compressFileTool.execute({ path: 'big.png', maxDim: 320, quality: 60 }, ctx);
    expect(res).toMatch(/smaller/);
    expect(isCompressibleImage('x.PNG')).toBe(true);
    expect(isCompressibleImage('x.txt')).toBe(false);
    expect(compressedName(src).endsWith('.small.jpg')).toBe(true);
  });

  it('refuses non-images with a fallback nudge', async () => {
    await fs.writeFile(join(hoisted.workspace, 't.txt'), 'x');
    const res = await compressFileTool.execute({ path: 't.txt' }, ctx);
    expect(res).toMatch(/run_command|web/i);
  });
});