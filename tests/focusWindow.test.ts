import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  return {
    app: {
      getPath: () => join(tmpdir(), 'spirit-test'),
      getName: () => 'Spirit',
      getVersion: () => 'test',
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
    },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    clipboard: { readText: () => '', writeText: vi.fn(), writeHTML: vi.fn(), readHTML: () => '' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    BrowserWindow: class {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    net: { request: vi.fn() },
  };
});

import { buildFocusPlan, focusWindowTool } from '../electron/llm/tools/focus-window';

describe('buildFocusPlan', () => {
  it('plans an app-name focus with the .exe stripped', () => {
    expect(buildFocusPlan({ app: 'notepad.exe' })).toEqual({ plan: { names: ['notepad'], title: undefined } });
  });

  it('plans a window-title focus when only a title is given', () => {
    expect(buildFocusPlan({ window: 'tasklist.txt — Notepad' })).toEqual({
      plan: { names: [], title: 'tasklist.txt — Notepad' },
    });
  });

  it('plans both when app and title are passed', () => {
    expect(buildFocusPlan({ app: 'Chrome', window: 'GitHub' })).toEqual({
      plan: { names: ['Chrome'], title: 'GitHub' },
    });
  });

  it('errors when neither app nor window is given', () => {
    const out = buildFocusPlan({});
    expect('error' in out).toBe(true);
    if ('error' in out) expect(out.error).toContain('focus_window needs');
  });

  it('ignores blank/whitespace args (errors like no args)', () => {
    expect('error' in buildFocusPlan({ app: '   ' })).toBe(true);
  });
});

describe('focusWindowTool', () => {
  it('declares the focus_window function with app and window args', () => {
    expect(focusWindowTool.declaration.function.name).toBe('focus_window');
    const props = focusWindowTool.declaration.function.parameters.properties as Record<string, unknown>;
    expect(props.app).toBeDefined();
    expect(props.window).toBeDefined();
  });

  it('labels the tool for the activity UI', () => {
    expect(focusWindowTool.uiLabel({ app: 'Notepad' })).toContain('Notepad');
    expect(focusWindowTool.uiLabel({ window: 'My Notes' })).toContain('My Notes');
  });
});