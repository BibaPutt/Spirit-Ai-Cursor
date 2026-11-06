import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../electron/llm/prompt';
import { compactForBudgetKeepLast, COMPACT_MARKER } from '../electron/llm/compact-history';

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

const hoisted = vi.hoisted(() => {
  let workspace = '';
  return {
    getWorkspace: () => workspace,
    setWorkspace: (v: string) => {
      workspace = v;
    },
  };
});
vi.mock('../electron/store/settings', () => ({
  getSettings: () => ({}),
  getWorkspaceFolder: () => hoisted.getWorkspace(),
}));

beforeEach(() => {
  hoisted.setWorkspace(join(tmpdir(), 'spirit-test'));
});

// Each message is a lot of tokens: system 250 chars => ~ 63 tokens at 4 chars/tok.
const sys: Message = { role: 'system', content: 'system'.repeat(250) };
const user = (text: string): Message => ({ role: 'user', content: text });
const assistant = (text: string): Message => ({ role: 'assistant', content: text });
const longTurn = (n: number): Message[] => [
  user(`user message payload number ${n} `.repeat(30)),
  assistant(`assistant reply payload number ${n} `.repeat(30)),
];

describe('compactForBudgetKeepLast', () => {
  it('returns unchanged when within budget', () => {
    const msgs = [sys, user('hi'), assistant('hello')];
    const r = compactForBudgetKeepLast(msgs, 10_000);
    expect(r.compacted).toBe(false);
    expect(r.messages).toHaveLength(msgs.length);
  });

  it('leaves tiny histories untouched', () => {
    const msgs = [sys, user('hi')];
    expect(compactForBudgetKeepLast(msgs, 100).compacted).toBe(false);
  });

  it('compacts old turns into a single digest keeping the query tail verbatim', () => {
    const msgs = [sys, ...longTurn(1), ...longTurn(2), ...longTurn(3), user('THE QUERY')];
    const r = compactForBudgetKeepLast(msgs, 1000, 1);
    expect(r.compacted).toBe(true);
    // [system, first user, digest, the query]
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0]).toEqual(sys);
    expect(r.messages[1]).toEqual(msgs[1]);
    expect(r.messages[2].role).toBe('assistant');
    expect(String(r.messages[2].content)).toContain(COMPACT_MARKER);
    // Tail preserved verbatim: query is right after the digest.
    expect(r.messages[3]).toEqual(user('THE QUERY'));
  });

  it('keeps multiple verbatim tail messages (2-turn tail)', () => {
    const msgs = [sys, ...longTurn(1), ...longTurn(2), user('q2'), assistant('a2')];
    const r = compactForBudgetKeepLast(msgs, 1000, 2);
    expect(r.messages.length).toBeGreaterThanOrEqual(5);
    expect(r.messages[r.messages.length - 1]).toEqual(assistant('a2'));
    expect(r.messages[r.messages.length - 2]).toEqual(user('q2'));
  });

  it('falls back to drop-middle truncation when even digest + tail cannot fit', () => {
    // The tail query itself is enormous (>budget), so no digest can rescue it.
    const msgs = [sys, ...longTurn(1), ...longTurn(2), user('Q'.repeat(3000))];
    const r = compactForBudgetKeepLast(msgs, 600, 1);
    expect(r.compacted).toBe(true);
    expect(r.messages.length).toBeLessThan(msgs.length);
    // The query is still the last verbatim message.
    expect(r.messages[r.messages.length - 1]).toEqual(user('Q'.repeat(3000)));
  });
});