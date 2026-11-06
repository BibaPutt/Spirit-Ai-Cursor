import { BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SaveResult, WebImage } from '../types';
import { renderHtmlDocument } from './template';
import { getWorkspaceFolder } from '../store/settings';
import { getAllOverlays } from '../windows/overlay';

// Native dialogs need to render ABOVE our overlay. Our overlays sit at the
// 'screen-saver' alwaysOnTop level — high enough that macOS save / open
// dialogs can land behind them. Lower the level for the duration of the
// dialog and restore afterwards.
export async function withOverlaysLowered<T>(fn: () => Promise<T>): Promise<T> {
  const overlays = getAllOverlays();
  overlays.forEach((w) => {
    if (!w.isDestroyed()) w.setAlwaysOnTop(false);
  });
  try {
    return await fn();
  } finally {
    overlays.forEach((w) => {
      if (!w.isDestroyed()) {
        w.setAlwaysOnTop(true, 'screen-saver');
        w.moveTop();
      }
    });
  }
}

function defaultFilename(prompt: string, ext: string): string {
  const cleaned = prompt
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);
  return `spirit-${stamp}-${cleaned || 'response'}.${ext}`;
}

async function ensureWorkspace(folder: string): Promise<void> {
  try {
    await fs.mkdir(folder, { recursive: true });
  } catch {
    /* user might have chosen a path that exists; ignore */
  }
}

export async function saveResponse(opts: {
  prompt: string;
  markdown: string;
  web: boolean;
  images?: WebImage[];
}): Promise<SaveResult> {
  const workspace = getWorkspaceFolder();
  await ensureWorkspace(workspace);

  const result = await withOverlaysLowered(() =>
    dialog.showSaveDialog({
      title: 'Save Spirit response',
      defaultPath: join(workspace, defaultFilename(opts.prompt, 'html')),
      filters: [
        { name: 'HTML (styled, A4 print-ready)', extensions: ['html'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Markdown', extensions: ['md'] },
      ],
      properties: ['showOverwriteConfirmation'],
    }),
  );

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  const ext = result.filePath.split('.').pop()?.toLowerCase() ?? 'html';
  try {
    if (ext === 'md') {
      await fs.writeFile(result.filePath, opts.markdown, 'utf-8');
      return { ok: true, path: result.filePath, format: 'md' };
    }

    const html = await renderHtmlDocument({
      prompt: opts.prompt,
      markdown: opts.markdown,
      web: opts.web,
      images: opts.images,
      generatedAt: new Date(),
    });

    if (ext === 'html') {
      await fs.writeFile(result.filePath, html, 'utf-8');
      return { ok: true, path: result.filePath, format: 'html' };
    }

    if (ext === 'pdf') {
      const buffer = await renderPdfFromHtml(html);
      await fs.writeFile(result.filePath, buffer);
      return { ok: true, path: result.filePath, format: 'pdf' };
    }

    return { ok: false, error: `Unsupported extension: ${ext}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Auto-save path used by the save_document tool: write the response EXACTLY as
// the model produced it — no doc template, no styling wrapper, no footer. The
// extension is chosen by the content itself: full HTML documents stay .html,
// everything else is saved verbatim as Markdown. No dialog, no prompt.
export async function saveResponseAuto(opts: {
  prompt: string;
  content: string;
}): Promise<SaveResult> {
  const workspace = getWorkspaceFolder();
  await ensureWorkspace(workspace);
  const content = opts.content ?? '';
  const ext = /^\s*<!doctype|^\s*<html/i.test(content) ? 'html' : 'md';
  const path = join(workspace, defaultFilename(opts.prompt, ext));
  try {
    await fs.writeFile(path, content, 'utf-8');
    return { ok: true, path, format: ext };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      offscreen: true,
    },
  });
  try {
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await win.loadURL(dataUrl);
    await new Promise((r) => setTimeout(r, 250));
    const buffer = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return buffer;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
