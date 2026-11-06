import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import type { Message } from '../electron/llm/prompt';

vi.mock('electron', () => {
  const fn = vi.fn(() => ({}));
  return {
    app: {
      isPackaged: false,
      getName: () => 'Spirit',
      getVersion: () => 'test',
      getPath: () => tmpdir(),
      whenReady: () => Promise.resolve(),
      on: fn,
      quit: fn,
    },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: fn, decryptString: fn },
    shell: { openPath: fn, openExternal: fn, showItemInFolder: fn },
  };
});

vi.mock('../electron/store/settings', () => ({
  getSettings: () => ({}),
  getWorkspaceFolder: () => tmpdir(),
}));

import { maskStaleObservations } from '../electron/memory/sessions';

const toolCall = (id: string, name: string, args = '{}') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});
const assistant = (content: string, calls: Array<ReturnType<typeof toolCall>> = []): Message => ({
  role: 'assistant',
  content,
  tool_calls: calls,
});
const toolMsg = (callId: string, content: string): Message => ({
  role: 'tool',
  tool_call_id: callId,
  content,
});

describe('maskStaleObservations — screen observations are masked after a screen change', () => {
  it('masks an earlier ui_read result once a ui_click runs later', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'click download now' },
      assistant('Reading.', [toolCall('c1', 'ui_read')]),
      toolMsg('c1', '1. "Download Now" button (el1)\n2. "Cancel" button (el2)'),
      assistant('Clicking.', [toolCall('c2', 'ui_click', '{"id":"el1"}')]),
      toolMsg('c2', 'Clicked el1 (text "Download Now") at (933, 533).'),
    ];
    const out = maskStaleObservations(messages);
    expect(out[3].role).toBe('tool');
    expect(out[3].content).toContain('superseded');
    // The click result itself is never touched.
    expect(out[5].content).toContain('Clicked el1');
  });

  it('keeps the LATEST ui_read result (no screen change after it)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'read the screen' },
      assistant('Reading.', [toolCall('c1', 'ui_read')]),
      toolMsg('c1', '1. "Download Now" button (el1)'),
    ];
    const out = maskStaleObservations(messages);
    expect(out[2].content).toContain('Download Now');
  });

  it('masks only the observations before the change, not a fresh read after it', () => {
    const messages: Message[] = [
      assistant('Old read.', [toolCall('c1', 'ui_read')]),
      toolMsg('c1', 'OLD ELEMENT LIST A'),
      assistant('Clicking.', [toolCall('c2', 'ui_click', '{"id":"el1"}')]),
      toolMsg('c2', 'Clicked.'),
      assistant('Verifying.', [toolCall('c3', 'ui_read')]),
      toolMsg('c3', 'FRESH ELEMENT LIST B'),
    ];
    const out = maskStaleObservations(messages);
    expect(out[1].content).toContain('superseded');
    expect(out[5].content).toContain('FRESH ELEMENT LIST B');
  });

  it('masks see_screen screenshots as well', () => {
    const messages: Message[] = [
      assistant('Looking.', [toolCall('c1', 'see_screen')]),
      toolMsg('c1', 'Screenshot taken.'),
      assistant('Scrolling.', [toolCall('c2', 'scroll', '{"delta":-300}')]),
      toolMsg('c2', 'Scrolled.'),
    ];
    const out = maskStaleObservations(messages);
    expect(out[1].content).toContain('superseded');
  });

  it('never touches non-observation tool results (clipboard, web, fetch)', () => {
    const messages: Message[] = [
      assistant('Searching.', [toolCall('c1', 'web_search')]),
      toolMsg('c1', 'MSI makes the Katana.'),
      assistant('Copying.', [toolCall('c2', 'copy_to_clipboard', '{"text":"hi"}')]),
      toolMsg('c2', 'Copied.'),
      assistant('Reading.', [toolCall('c3', 'read_clipboard')]),
      toolMsg('c3', 'Clipboard has hi.'),
      assistant('Opening.', [toolCall('c4', 'open_url', '{"url":"https://msi.com"}')]),
      toolMsg('c4', 'Opened.'),
    ];
    const out = maskStaleObservations(messages);
    expect(out[1].content).toContain('Katana');
    expect(out[3].content).toContain('Copied.');
    expect(out[5].content).toContain('Clipboard has hi.');
    expect(out[7].content).toContain('Opened.');
  });

  it('returns the original array untouched when nothing is masked', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      assistant('ok'),
    ];
    expect(maskStaleObservations(messages)).toBe(messages);
  });
});
