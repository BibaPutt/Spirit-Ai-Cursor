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
      // Route userData to the OS temp dir so electron-store never writes a
      // config.json into the project tree during tests.
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
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
      openPath: vi.fn(() => Promise.resolve()),
      showItemInFolder: fn,
    },
    nativeImage: { createFromPath: fn, createFromBuffer: fn, createEmpty: fn },
    clipboard: { readText: () => '', writeText: fn, writeHTML: fn, readHTML: () => '' },
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

import { parseTextToolCalls } from '../electron/llm/providers/router';

describe('parseTextToolCalls', () => {
  it('parses the llama.cpp "call:" prefixed form with template tokens', () => {
    const calls = parseTextToolCalls('call:ui_click(id="el1")<tool_call|>');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('ui_click');
    expect(calls[0].args).toEqual({ id: 'el1' });
    expect(calls[0].raw).toBe('call:ui_click(id="el1")');
  });

  it('parses bare underscored tool calls like ui_click("el3")', () => {
    const calls = parseTextToolCalls('ui_click("el3")');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('ui_click');
    expect(calls[0].args).toEqual({ id: 'el3' });
  });

  it('keeps a bare numeric id a number', () => {
    const calls = parseTextToolCalls('ui_click(3)');
    expect(calls[0].args).toEqual({ id: 3 });
  });

  it('parses key=value and JSON arg forms', () => {
    expect(parseTextToolCalls('call:type_text(text="hello")')[0].args).toEqual({ text: 'hello' });
    expect(parseTextToolCalls('call:ui_click({"id":"el9"})')[0].args).toEqual({ id: 'el9' });
    expect(parseTextToolCalls('call:ui_click(id=el2)')[0].args).toEqual({ id: 'el2' });
  });

  it('parses positional args for click / wait / scroll', () => {
    expect(parseTextToolCalls('call:click(500, 300)')[0].args).toEqual({ x: 500, y: 300 });
    expect(parseTextToolCalls('call:wait(1000)')[0].args).toEqual({ ms: 1000 });
    expect(parseTextToolCalls('call:scroll(3)')[0].args).toEqual({ delta: 3 });
  });

  it('parses multiple calls and strips raw text from the result', () => {
    const calls = parseTextToolCalls(
      'I see it. call:ui_click(id="el5") then call:type_text(text="ok")',
    );
    expect(calls.map((c) => c.name)).toEqual(['ui_click', 'type_text']);
  });

  it('does not treat prose "click (button)" as a tool call', () => {
    expect(parseTextToolCalls('you can click (button) anywhere')).toHaveLength(0);
    expect(parseTextToolCalls('Press the red button')).toHaveLength(0);
  });

  it('does not parse a bare short-word call without a call:/backtick prefix', () => {
    expect(parseTextToolCalls('click(500, 300)')).toHaveLength(0);
    expect(parseTextToolCalls('wait(1000)')).toHaveLength(0);
  });

  it('parses backticked tool calls', () => {
    const calls = parseTextToolCalls('use `ui_click(id="el7")` now');
    expect(calls[0].name).toBe('ui_click');
    expect(calls[0].args).toEqual({ id: 'el7' });
  });
});
