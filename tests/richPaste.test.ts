import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const fn = vi.fn(() => ({}));
  const display = {
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
  };
  return {
    app: {
      isPackaged: false,
      getName: () => 'Spirit',
      getVersion: () => 'test',
      getPath: () => join(tmpdir(), 'spirit-test'),
      whenReady: () => Promise.resolve(),
      on: fn,
      quit: fn,
    },
    BrowserWindow: class {},
    dialog: { showOpenDialog: fn, showSaveDialog: fn, showMessageBox: fn },
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
    shell: { openExternal: fn, openPath: fn, showItemInFolder: fn },
    nativeImage: { createFromPath: fn, createFromBuffer: fn, createEmpty: fn },
    clipboard: {
      readText: () => '',
      writeText: fn,
      writeHTML: fn,
      readHTML: () => '',
      readRTF: () => '',
      write: fn,
      readImage: () => ({ isEmpty: () => true }),
    },
    contextBridge: { exposeInMainWorld: fn },
    ipcRenderer: { on: fn, invoke: fn, send: fn, removeListener: fn },
    ipcMain: { handle: fn, on: fn },
    desktopCapturer: { getSources: vi.fn(() => Promise.resolve([])) },
    Menu: { buildFromTemplate: () => ({ popup: fn }), setApplicationMenu: fn },
    Tray: class {},
    net: { request: fn },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: fn, decryptString: fn },
    systemPreferences: { getAccentColor: fn },
    globalShortcut: { register: () => true, unregister: fn, unregisterAll: fn },
  };
});

import { htmlTableToCsv, rtfTableToCsv } from '../electron/llm/tools/read-table';
import { buildTableCsv, buildTableHtml } from '../electron/llm/tools/paste-table';

const SAMPLE_HTML = `<table><tr><td>Name</td><td>Score</td></tr><tr><td>Ann</td><td>9</td></tr></table>`;

describe('htmlTableToCsv', () => {
  it('extracts a table from Excel-style clipboard HTML as TSV', () => {
    expect(htmlTableToCsv(SAMPLE_HTML)).toBe('Name\tScore\nAnn\t9');
  });

  it('handles <th> cells and inline styles', () => {
    const html = `<table><tr><th style="font-weight:bold">A</th><th>B</th></tr></table>`;
    expect(htmlTableToCsv(html)).toBe('A\tB');
  });

  it('strips HTML entities inside cells', () => {
    const html = `<table><tr><td>Tom &amp; Jerry</td><td>&gt;5</td></tr></table>`;
    expect(htmlTableToCsv(html)).toBe('Tom & Jerry\t>5');
  });

  it('quotes cells that contain tabs or quotes', () => {
    const html = `<table><tr><td>a"b</td><td>x\ty</td></tr></table>`;
    expect(htmlTableToCsv(html)).toBe('"a""b"\t"x\ty"');
  });

  it('returns null when there is no table markup', () => {
    expect(htmlTableToCsv('<p>just text</p>')).toBeNull();
  });
});

describe('rtfTableToCsv', () => {
  it('extracts cells and rows from an RTF table', () => {
    const rtf = String.raw`{\rtf1{\*\generator Excel}\trowd\cellx5000 A\cell B\row\cellx5000 1\cell 2\row}`;
    expect(rtfTableToCsv(rtf)).toBe('A\tB\n1\t2');
  });

  it('returns null when RTF has no table markup', () => {
    expect(rtfTableToCsv(String.raw`{\rtf1 hello}`)).toBeNull();
  });
});

describe('buildTableCsv / buildTableHtml', () => {
  it('builds TSV from a row matrix', () => {
    expect(buildTableCsv([['Name', 'Score'], ['Ann', '9']])).toBe('Name\tScore\nAnn\t9');
  });

  it('builds an HTML <table> with escaped cells', () => {
    const html = buildTableHtml([['a<b', 'c&d']]);
    expect(html).toContain('<table');
    expect(html).toContain('<td>a&lt;b</td>');
    expect(html).toContain('<td>c&amp;d</td>');
  });

  it('round-trips a built HTML table through htmlTableToCsv', () => {
    const html = buildTableHtml([['Name', 'Score'], ['Ann', '9']]);
    expect(htmlTableToCsv(html)).toBe('Name\tScore\nAnn\t9');
  });
});
