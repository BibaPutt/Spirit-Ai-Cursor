import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadableStream } from 'node:stream/web';

// The chips-only Local AI slot (chipsLocalAiConfig) can point at a different
// server + model than the main providers slot. localaiChipsProvider must read
// the chips slot; localaiProvider must keep reading the main slot.
const hoisted = vi.hoisted(() => ({
  mainCfg: {
    apiKey: '',
    enabled: true,
    baseUrl: 'http://localhost:8081/',
    model: 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf',
    availableModels: [] as Array<{ id: string }>,
    vision: true,
    tools: true,
    web: false,
    contextLength: 16384,
  },
  chipsCfg: {
    apiKey: '',
    enabled: true,
    baseUrl: 'http://localhost:8082/',
    model: 'gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf',
    availableModels: [] as Array<{ id: string }>,
    vision: true,
    tools: true,
    web: false,
    contextLength: 16384,
  },
}));

vi.mock('../electron/store/settings', () => ({
  getLocalAiConfig: () => hoisted.mainCfg,
  getChipsLocalAiConfig: () => hoisted.chipsCfg,
}));

import { localaiChipsProvider, localaiProvider } from '../electron/llm/providers/localai';

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

const STREAM = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

describe('localai chips provider uses the chips config slot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pickModel returns the chips model for localaiChipsProvider and the main model for localaiProvider', () => {
    expect(localaiChipsProvider.pickModel({} as never)).toBe(hoisted.chipsCfg.model);
    expect(localaiProvider.pickModel({} as never)).toBe(hoisted.mainCfg.model);
  });

  it('supports reads capability toggles from the injected slot', () => {
    expect(localaiChipsProvider.supports('vision')).toBe(true);
    expect(localaiChipsProvider.supports('web')).toBe(false);
    expect(localaiProvider.supports('vision')).toBe(true);
  });

  it('runRound posts to the chips base URL with the chips model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(STREAM));
    vi.stubGlobal('fetch', fetchMock);

    const result = await localaiChipsProvider.runRound(
      hoisted.chipsCfg.model,
      [{ role: 'user', content: 'hi' }],
      '',
      undefined,
      undefined,
      () => {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8082/v1/chat/completions');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body));
    expect(body.model).toBe(hoisted.chipsCfg.model);
    expect(result.contentText).toBe('ok');
  });

  it('the main localai provider still targets the main server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(STREAM));
    vi.stubGlobal('fetch', fetchMock);

    await localaiProvider.runRound(
      hoisted.mainCfg.model,
      [{ role: 'user', content: 'hi' }],
      '',
      undefined,
      undefined,
      () => {},
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8081/v1/chat/completions');
  });
});
