import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadableStream } from 'node:stream/web';

const hoisted = vi.hoisted(() => ({
  cfg: {
    apiKey: '',
    enabled: true,
    baseUrl: 'http://127.0.0.1:4096',
    model: 'some-free-model',
    availableModels: [],
    vision: false,
    tools: true,
    web: false,
    contextLength: undefined,
  },
}));

vi.mock('../electron/store/settings', () => ({
  getOpencodeConfig: () => hoisted.cfg,
}));

import {
  opencodeProvider,
  resolveOpencodeEndpoint,
  setOpencodeRetryDelayForTests,
} from '../electron/llm/providers/opencode';

function sseBody(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function okResponse(text: string): { ok: true; status: number; statusText: string; body: ReadableStream<Uint8Array> } {
  return { ok: true, status: 200, statusText: 'OK', body: sseBody(text) };
}

const STREAM = 'data: {"choices":[{"delta":{"content":"free answer"}}]}\n\ndata: [DONE]\n\n';

describe('resolveOpencodeEndpoint', () => {
  it('normalizes to the /v1 prefix', () => {
    expect(resolveOpencodeEndpoint('http://127.0.0.1:4096')).toBe('http://127.0.0.1:4096/v1');
    expect(resolveOpencodeEndpoint('http://127.0.0.1:4096/v1/')).toBe('http://127.0.0.1:4096/v1');
    expect(resolveOpencodeEndpoint('http://127.0.0.1:4096/models')).toBe('http://127.0.0.1:4096/v1');
  });
});

describe('opencode provider (OpenAI wire)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setOpencodeRetryDelayForTests(null);
  });

  beforeEach(() => {
    // Instant retries: production waits 2-4s between attempts.
    setOpencodeRetryDelayForTests(0);
  });

  it('posts chat completions to the proxy and streams the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(STREAM));
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    const result = await opencodeProvider.runRound(
      'some-free-model',
      [{ role: 'user', content: 'hi' }],
      '',
      undefined,
      undefined,
      (chunk) => chunks.push(chunk),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:4096/v1/chat/completions');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body));
    expect(body.model).toBe('some-free-model');
    expect(body.stream).toBe(true);
    expect(result.contentText).toBe('free answer');
    expect(chunks.join('')).toContain('free answer');
  });

  it('sends its own stable session id (own upstream lane)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(STREAM));
    vi.stubGlobal('fetch', fetchMock);

    const run = () =>
      opencodeProvider.runRound(
        'some-free-model',
        [{ role: 'user', content: 'hi' }],
        '',
        undefined,
        undefined,
        () => {},
      );
    await run();
    await run();

    const h1 = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    const h2 = (fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers;
    expect(h1['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
    expect(h2['x-opencode-session']).toBe(h1['x-opencode-session']);
  });

  it('forwards tools when the toggle is on', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(STREAM));
    vi.stubGlobal('fetch', fetchMock);

    await opencodeProvider.runRound(
      'some-free-model',
      [{ role: 'user', content: 'hi' }],
      '',
      [{ type: 'function', function: { name: 'ui_read', description: '', parameters: {} } }],
      undefined,
      () => {},
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body));
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });

  it('strips screenshot blocks when vision is off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(STREAM));
    vi.stubGlobal('fetch', fetchMock);

    await opencodeProvider.runRound(
      'some-free-model',
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
          ],
        },
      ],
      '',
      undefined,
      undefined,
      () => {},
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body));
    const content = body.messages[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
  });

  it('supports follows the stored toggles', () => {
    expect(opencodeProvider.supports('tools')).toBe(true);
    expect(opencodeProvider.supports('vision')).toBe(false);
    expect(opencodeProvider.supports('web')).toBe(false);
    expect(opencodeProvider.supports('nope')).toBe(false);
  });

  it('propagates a non-OK response as an error', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      opencodeProvider.runRound('some-free-model', [{ role: 'user', content: 'hi' }], '', undefined, undefined, () => {}),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('retries a 401 chat rejection once via /v1/responses', async () => {
    const calls: string[] = [];
    const responsesStream =
      'data: {"type":"response.output_text.delta","delta":"hello "}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"via responses"}\n\n' +
      'data: {"type":"response.completed","response":{}}\n\n';
    let chats = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/v1/chat/completions')) {
        chats++;
        return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'nope' };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: sseBody(responsesStream),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    const result = await opencodeProvider.runRound(
      'some-free-model',
      [{ role: 'user', content: 'hi' }],
      '',
      undefined,
      undefined,
      (chunk) => chunks.push(chunk),
    );

    // chat, same-shape chat retry, then cross-shape responses fallback.
    expect(chats).toBe(2);
    expect(calls).toEqual([
      'http://127.0.0.1:4096/v1/chat/completions',
      'http://127.0.0.1:4096/v1/chat/completions',
      'http://127.0.0.1:4096/v1/responses',
    ]);
    expect(result.contentText).toBe('hello via responses');
    expect(result.finishReason).toBe('stop');
  });

  it('does not retry a 400 through responses', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return { ok: false, status: 400, statusText: 'Bad Request', text: async () => 'bad' };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      opencodeProvider.runRound('some-free-model', [{ role: 'user', content: 'hi' }], '', undefined, undefined, () => {}),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual(['http://127.0.0.1:4096/v1/chat/completions']);
  });
});
