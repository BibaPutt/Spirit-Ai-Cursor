import { describe, expect, it, vi } from 'vitest';
import { TOOLS, getTool } from '../electron/llm/tools';
import { isApprovalRequired } from '../electron/llm/tools/approval';
import { webSearchTool } from '../electron/llm/tools/web-search';

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

const webSearchMock = vi.hoisted(() => ({
  results:
    '[GROUNDED_SEARCH query="msi laptops"]\n1. MSI Laptops — https://www.msi.com/laptops',
}));

vi.mock('../electron/llm/web-ground', () => ({
  searchWebGround: vi.fn(async (_query: string) => webSearchMock.results),
  parseDdgGrounding: () => '',
  parseBingGrounding: () => '',
}));

describe('new universal tool registration', () => {
  it('registers web_search, list_apps, system_action and run_command', () => {
    expect(TOOLS.web_search).toBeDefined();
    expect(TOOLS.list_apps).toBeDefined();
    expect(TOOLS.list_processes).toBeDefined();
    expect(TOOLS.laya_decide).toBeDefined();
    expect(TOOLS.read_file).toBeDefined();
    expect(TOOLS.edit_file).toBeDefined();
    expect(TOOLS.list_dir).toBeDefined();
    expect(TOOLS.compress_file).toBeDefined();
    expect(TOOLS.task).toBeDefined();
    expect(TOOLS.question).toBeDefined();
    expect(TOOLS.system_action).toBeDefined();
    expect(TOOLS.run_command).toBeDefined();
    expect(TOOLS.create_file).toBeDefined();
    expect(TOOLS.open_file).toBeDefined();
  });

  it('web_search is read-only and needs no approval', () => {
    expect(isApprovalRequired('web_search')).toBe(false);
    expect(isApprovalRequired('list_apps')).toBe(false);
    expect(isApprovalRequired('list_processes')).toBe(false);
    expect(isApprovalRequired('laya_decide')).toBe(false);
    expect(isApprovalRequired('read_file')).toBe(false);
    expect(isApprovalRequired('list_dir')).toBe(false);
    expect(isApprovalRequired('compress_file')).toBe(false);
    expect(isApprovalRequired('question')).toBe(false);
    expect(isApprovalRequired('edit_file')).toBe(true);
    expect(isApprovalRequired('task')).toBe(true);
  });

  it('system_action and run_command require approval like launch_app', () => {
    expect(isApprovalRequired('system_action')).toBe(true);
    expect(isApprovalRequired('run_command')).toBe(true);
    expect(isApprovalRequired('launch_app')).toBe(true);
    expect(isApprovalRequired('create_file')).toBe(true);
    expect(isApprovalRequired('open_file')).toBe(true);
  });

  it('web_search answers from real grounded results', async () => {
    const res = await webSearchTool.execute(
      { query: 'msi laptops' },
      {
        latestAssistantText: '',
        originalPrompt: 'x',
        abort: new AbortController().signal,
      } as never,
    );
    expect(res).toContain('MSI Laptops');
    expect(res).toContain('[GROUNDED_SEARCH query="msi laptops"]');
  });

  it('web_search surfaces a helpful error when nothing is found', async () => {
    webSearchMock.results = '';
    const res = await webSearchTool.execute(
      { query: 'nothing' },
      {
        latestAssistantText: '',
        originalPrompt: 'x',
        abort: new AbortController().signal,
      } as never,
    );
    expect(res).toContain('Error');
    expect(res).toContain('Try a different query');
  });

  it('getTool resolves the registered web_search definition', () => {
    expect(getTool('web_search')).toBeDefined();
    expect(getTool('list_apps')).toBeDefined();
    expect(getTool('system_action')).toBeDefined();
    expect(getTool('run_command')).toBeDefined();
    expect(getTool('create_file')).toBeDefined();
    expect(getTool('open_file')).toBeDefined();
  });
});
