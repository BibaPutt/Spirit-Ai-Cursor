import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import {
  maskTurnOneOnPivot,
  truncateForBudget,
  truncateForBudgetKeepLast,
} from '../electron/memory/sessions';

beforeEach(() => {
  hoisted.setWorkspace(join(tmpdir(), 'spirit-test'));
});

const sys: Message = { role: 'system', content: 'system'.repeat(250) };
const user = (text: string): Message => ({ role: 'user', content: text });
const assistant = (text: string, toolCalls?: unknown): Message =>
  toolCalls
    ? { role: 'assistant', content: text, tool_calls: toolCalls }
    : { role: 'assistant', content: text };
const toolMsg = (text: string): Message => ({ role: 'tool', tool_call_id: 'call_1', content: text });

function toolCallsBlock(json: string): Array<{ id: string; type: string; function: { name: string; arguments: string } }> {
  return [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'ui_click', arguments: JSON.stringify({ id: 'el1' }) + json },
    },
  ];
}

describe('truncateForBudget — tool-call group integrity', () => {
  it('never leaves an assistant tool_call orphaned at the trimmed head', () => {
    const messages: Message[] = [
      sys,
      user('first user'.repeat(200)),
      assistant('', toolCallsBlock('x'.repeat(500))),
      toolMsg('tool result one'),
      user('second user'.repeat(200)),
      assistant('', toolCallsBlock('y'.repeat(500))),
      toolMsg('tool result two'),
      user('third user'.repeat(200)),
      assistant('final answer'),
    ];
    const out = truncateForBudget(messages, 400);

    // system + first user survive unconditionally.
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);

    // The middle of the trimmed array must start with a USER message — the
    // drop loop stops at (and keeps) the next user, so no stray assistant or
    // tool message can end up at the head with its tool responses gone.
    const middle = out.slice(2);
    if (middle.length > 0) {
      expect(middle[0].role).toBe('user');
    }

    // Structural integrity: every surviving assistant message that has
    // tool_calls must be immediately followed by its tool response(s), never
    // by another assistant or user message.
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls) {
        expect(out[i + 1]?.role).toBe('tool');
      }
    }
  });

  it('returns the array unchanged when it already fits the budget', () => {
    const messages: Message[] = [sys, user('hi'), assistant('ok')];
    const out = truncateForBudget(messages, 10000);
    expect(out).toBe(messages);
  });

  it('a group dropped as the oldest turn is dropped whole', () => {
    const messages: Message[] = [
      sys,
      user('first user'.repeat(200)),
      assistant('', toolCallsBlock('x'.repeat(500))),
      toolMsg('tool result one'),
      user('second user'.repeat(200)),
      assistant('kept answer'),
    ];
    const out = truncateForBudget(messages, 200);

    // If trimming happened, the entire oldest tool group (assistant + its tool
    // response) went away together — never a half-group.
    const middle = out.slice(2);
    if (middle.length > 0) {
      expect(middle[0].role).toBe('user');
    }
    const orphanedToolCalls = out.some(
      (m, i) => m.role === 'assistant' && 'tool_calls' in m && m.tool_calls && out[i + 1]?.role !== 'tool',
    );
    expect(orphanedToolCalls).toBe(false);
  });
});

describe('truncateForBudgetKeepLast — preserves the current turn during the post-memory guard pass', () => {
  it('never drops the last (just-typed) user message even when the head overflows', () => {
    const messages: Message[] = [
      sys,
      user('first user'.repeat(400)),
      assistant('answer one'.repeat(200)),
      user('second user'.repeat(200)),
      assistant('answer two'.repeat(200)),
      user('the current question'),
    ];
    const out = truncateForBudgetKeepLast(messages, 300);

    // Oldest turns get cut, but the current question and the screenshot-bearing
    // first turn always survive.
    expect(out[out.length - 1]).toBe(messages[messages.length - 1]);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
  });

  it('tail=0 behaves exactly like truncateForBudget (current turn can be cut)', () => {
    const messages: Message[] = [
      sys,
      user('first user'.repeat(400)),
      assistant('answer one'.repeat(200)),
      user('second user'.repeat(200)),
      assistant('answer two'.repeat(200)),
      user('the current question'),
    ];
    expect(truncateForBudgetKeepLast(messages, 300, 0)).toEqual(truncateForBudget(messages, 300));
  });

  it('preserves tailCount=2 (question + the answer streaming behind it)', () => {
    const messages: Message[] = [
      sys,
      user('first user'.repeat(400)),
      assistant('answer one'.repeat(200)),
      user('second user'.repeat(200)),
      assistant('answer two'.repeat(200)),
      user('current question'),
      assistant('streaming answer'),
    ];
    const out = truncateForBudgetKeepLast(messages, 300, 2);
    expect(out[out.length - 1]).toBe(messages[messages.length - 1]);
    expect(out[out.length - 2]).toBe(messages[messages.length - 2]);
  });

  it('returns the array unchanged when it already fits the budget', () => {
    const messages: Message[] = [sys, user('hi'), assistant('ok'), user('now?')];
    expect(truncateForBudgetKeepLast(messages, 10000)).toBe(messages);
  });

  it('returns immediately when the preserved tail covers everything', () => {
    const two: Message[] = [sys, user('hi')];
    expect(truncateForBudgetKeepLast(two, 1)).toBe(two);
    const allTail: Message[] = [sys, user('hi'), user('also tail')];
    expect(truncateForBudgetKeepLast(allTail, 1, 2)).toBe(allTail);
  });
});

describe('maskTurnOneOnPivot', () => {
  const firstUserWithOcr = (): Message => ({
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'what are cows\n\nOCR:\nCow milking schedule 06:00\nneeds feedback on cattle',
      },
    ],
  });

  it('replaces the heavy first-turn text with a compact stub that keeps the original question', () => {
    const messages: Message[] = [
      sys,
      firstUserWithOcr(),
      assistant('Cows are...'.repeat(50)),
      user('what is a widget'),
    ];
    const out = maskTurnOneOnPivot(messages);
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1].role).toBe('user');
    const text =
      typeof out[1].content === 'string'
        ? out[1].content
        : out[1].content.map((p) => ('text' in p ? p.text : '')).join('\n');
    expect(text).toContain('what are cows');
    expect(text).not.toContain('Cow milking schedule');
    expect(out[2]).toBe(messages[2]);
    expect(out[3]).toBe(messages[3]);
  });

  it('preserves non-text (image) parts of the first message', () => {
    const messages: Message[] = [
      sys,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what are cows\n\nOCR: milking schedule' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
        ],
      },
    ];
    const out = maskTurnOneOnPivot(messages);
    expect(Array.isArray(out[1].content)).toBe(true);
    const parts = out[1].content as Array<{ type: string; image_url?: { url: string } }>;
    const images = parts.filter((p) => p.type === 'image_url');
    expect(images).toHaveLength(1);
    expect((images[0].image_url as { url: string }).url).toBe('data:image/jpeg;base64,abc');
    expect(parts.some((p) => p.type === 'text' && p.text!.includes('milking'))).toBe(false);
  });

  it('returns the array unchanged when there is no first user message', () => {
    const onlySys: Message[] = [sys];
    expect(maskTurnOneOnPivot(onlySys)).toBe(onlySys);
    const noUser = [sys, assistant('...')] as Message[];
    expect(maskTurnOneOnPivot(noUser)).toBe(noUser);
  });

  it('leaves a short first turn untouched when it has no context blocks to strip', () => {
    const messages: Message[] = [sys, user('ok'), assistant('hi'), user('next')];
    const out = maskTurnOneOnPivot(messages);
    expect(out).toHaveLength(messages.length);
    const stub =
      typeof out[1].content === 'string'
        ? out[1].content
        : (out[1].content as Array<{ type: string; text?: string }>)
            .map((p) => p.text ?? '')
            .join('\n');
    expect(stub).toContain('ok');
  });
});
