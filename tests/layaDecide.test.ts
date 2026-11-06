import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  askLaya,
  layaDecideTool,
  markLayaHealth,
} from '../electron/llm/tools/laya-decide';

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

describe('laya_decide tool', () => {
  beforeEach(() => {
    markLayaHealth(true);
  });

  it('asks intent and renders one line', async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ answers: { intent: { choice: 'summarize', answer_confidence: 0.99 } } }),
    );
    const out = await askLaya(
      'intent',
      'summarize this pdf',
      [],
      'http://127.0.0.1:8000',
      fetchMock as never,
    );
    expect(out).toBe('intent: summarize (99%)');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body));
    expect(body.questions.intent.type).toBe('choice');
  });

  it('renders safety yes/no and maps pick indices to labels', async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ answers: { sensitive: { noul: 0.97, answer_confidence: 0.97 } } }),
    );
    expect(
      await askLaya('safety', 'copy the password', [], 'http://127.0.0.1:8000', fetchMock as never),
    ).toBe('sensitive: yes (97%)');

    const fetchPick = vi.fn(async () =>
      okJson({ answers: { pick: { choice: 'option_1', answer_confidence: 0.8 } } }),
    );
    expect(
      await askLaya('pick', 'which button', ['Back', 'Buy'], 'http://127.0.0.1:8000', fetchPick as never),
    ).toBe('pick: Buy (80%)');
  });

  it('falls back to plain text on any failure, never throws', async () => {
    const down = vi.fn(async () => {
      throw new Error('refused');
    });
    expect(await askLaya('intent', 'hi', [], 'http://127.0.0.1:8000', down as never)).toMatch(
      /unavailable/,
    );

    const bad = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    expect(await askLaya('intent', 'hi', [], 'http://127.0.0.1:8000', bad as never)).toMatch(
      /unavailable/,
    );
  });

  it('skips dialing when health cache says down', async () => {
    markLayaHealth(false);
    const fetchMock = vi.fn(async () => okJson({ answers: {} }));
    // Force cache: knock again would re-check, so prime down then call.
    const out = await askLaya('intent', 'hi', [], 'http://127.0.0.1:1', fetchMock as never);
    expect(out).toMatch(/unavailable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates preset and state', async () => {
    const ctx = { latestAssistantText: '', originalPrompt: '' } as never;
    expect(await layaDecideTool.execute({ preset: 'nope', state: 'x' }, ctx)).toMatch(/unknown preset/);
    expect(await layaDecideTool.execute({ preset: 'intent', state: '  ' }, ctx)).toMatch(/needs a "state"/);
    expect(await layaDecideTool.execute({ preset: 'pick', state: 'x', options: [] }, ctx)).toMatch(
      /needs an "options" list/,
    );
  });
});
