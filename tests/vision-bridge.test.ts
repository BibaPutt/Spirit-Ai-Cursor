import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// Vision bridge: gives TEXT-ONLY models a way to "see" the screen through a
// separate vision-capable endpoint. The module reads provider config from
// settings.ts (mocked here) and provider model picking from registry.ts
// (mocked here); the fetch POST and the sharp crop run for real.

const hoisted = vi.hoisted(() => {
  const cfg: Record<string, unknown> = {
    apiKey: '',
    enabled: true,
    baseUrl: '',
    model: '',
    availableModels: [],
    vision: false,
    tools: true,
    web: false,
    useVisionBridge: false,
    visionBridgeUrl: '',
    visionBridgeModel: '',
  };
  const providers: Record<string, unknown> = {
    openrouter: { enabled: false, hasKey: false },
    openai: { enabled: false, hasKey: false },
    gemini: { enabled: false, hasKey: false },
  };
  const providerClients: Record<string, { pickModel: (req: unknown) => string }> = {};
  return {
    cfg,
    providers,
    providerClients,
    getLocalAiConfig: vi.fn(() => hoisted.cfg),
    getSettingsLight: vi.fn(() => ({ providers: hoisted.providers })),
    getDecryptedProviderKey: vi.fn((id: string) => `sk-${id}`),
    getVisionBridgeKey: vi.fn(() => 'sk-bridge-key'),
    hasProviderKey: vi.fn((id: string) =>
      (hoisted.providers[id] as { hasKey?: boolean } | undefined)?.hasKey === true,
    ),
    hasVisionBridgeKey: vi.fn(() => true),
    getProvider: vi.fn(
      (id: string) =>
        hoisted.providerClients[id] ?? { pickModel: () => 'auto-model' },
    ),
  };
});

vi.mock('../electron/store/settings', () => ({
  getLocalAiConfig: hoisted.getLocalAiConfig,
  getChipsLocalAiConfig: hoisted.getLocalAiConfig,
  getSettingsLight: hoisted.getSettingsLight,
  getDecryptedProviderKey: hoisted.getDecryptedProviderKey,
  getVisionBridgeKey: hoisted.getVisionBridgeKey,
  hasProviderKey: hoisted.hasProviderKey,
  hasVisionBridgeKey: hoisted.hasVisionBridgeKey,
}));
vi.mock('../electron/llm/providers/registry', () => ({
  getProvider: hoisted.getProvider,
}));

import {
  describeScreenshot,
  isVisionBridgeEnabled,
  resolveBridgeTarget,
  cropRegionB64,
  SUBMIT_TIMEOUT_MS,
} from '../electron/llm/vision-bridge';

function resetConfig(): void {
  Object.assign(hoisted.cfg, {
    useVisionBridge: false,
    visionBridgeUrl: '',
    visionBridgeModel: '',
  });
  hoisted.providers.openrouter = { enabled: false, hasKey: false };
  hoisted.providers.openai = { enabled: false, hasKey: false };
  hoisted.providers.gemini = { enabled: false, hasKey: false };
  hoisted.providerClients.openai = { pickModel: () => 'gpt-4o-mini' };
  hoisted.providerClients.openrouter = { pickModel: () => 'some-openrouter-model' };
  hoisted.hasVisionBridgeKey.mockReturnValue(true);
  hoisted.getVisionBridgeKey.mockReturnValue('sk-bridge-key');
  hoisted.getDecryptedProviderKey.mockReturnValue('sk-decrypted');
}

describe('vision bridge', () => {
  beforeEach(() => {
    resetConfig();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('is disabled when the switch is off even with a manual endpoint configured', () => {
    hoisted.cfg.visionBridgeUrl = 'http://localhost:1234/v1';
    hoisted.cfg.visionBridgeModel = 'gpt-4o';
    expect(isVisionBridgeEnabled()).toBe(false);
    expect(resolveBridgeTarget()).toBeNull();
  });

  it('resolves a manual target using the stored bridge key and the normalized endpoint', () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.cfg.visionBridgeUrl = 'http://localhost:1234';
    hoisted.cfg.visionBridgeModel = 'qwen2-vl';
    const t = resolveBridgeTarget();
    expect(t).not.toBeNull();
    expect(t!.chatCompletionsUrl).toBe('http://localhost:1234/v1/chat/completions');
    expect(t!.apiKey).toBe('sk-bridge-key');
    expect(t!.model).toBe('qwen2-vl');
    expect(t!.label).toContain('manual');
  });

  it('treats an api.deepseek.com-style base without /v1 the same way', () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.cfg.visionBridgeUrl = 'https://api.deepseek.com';
    hoisted.cfg.visionBridgeModel = 'deepseek-vl';
    const t = resolveBridgeTarget();
    expect(t!.chatCompletionsUrl).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('falls back to the first enabled cloud provider when the manual target has no key', () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.cfg.visionBridgeUrl = 'http://localhost:1234/v1';
    hoisted.cfg.visionBridgeModel = 'some-model';
    hoisted.hasVisionBridgeKey.mockReturnValue(false);
    hoisted.getVisionBridgeKey.mockReturnValue('');
    hoisted.providers.openai = { enabled: true, hasKey: true };
    const t = resolveBridgeTarget();
    expect(t).not.toBeNull();
    expect(t!.chatCompletionsUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(t!.model).toBe('gpt-4o-mini');
    expect(t!.label).toBe('OpenAI');
    expect(hoisted.getDecryptedProviderKey).toHaveBeenCalledWith('openai');
  });

  it('prefers openrouter, then openai, then gemini in the router shortlist order', () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.providers.openrouter = { enabled: true, hasKey: true };
    hoisted.providers.openai = { enabled: true, hasKey: true };
    let t = resolveBridgeTarget();
    expect(t!.label).toBe('OpenRouter');
    expect(t!.chatCompletionsUrl).toBe('https://openrouter.ai/api/v1/chat/completions');

    hoisted.providers.openrouter = { enabled: false, hasKey: true };
    hoisted.providers.openai = { enabled: false, hasKey: true };
    hoisted.providers.gemini = { enabled: true, hasKey: true };
    t = resolveBridgeTarget();
    expect(t!.label).toBe('Gemini');
    expect(t!.chatCompletionsUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('returns null when enabled but nothing usable is configured', () => {
    hoisted.cfg.useVisionBridge = true;
    expect(isVisionBridgeEnabled()).toBe(false);
    expect(resolveBridgeTarget()).toBeNull();
  });

  it('describeScreenshot posts the OpenAI image payload and returns the model text', async () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.cfg.visionBridgeUrl = 'http://localhost:1234/v1';
    hoisted.cfg.visionBridgeModel = 'gpt-4o';
    let captured: { url: string; init: RequestInit; bodyText: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { url: String(input), init: init ?? {}, bodyText: String(init?.body) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'A file explorer with a highlighted "Reports" folder.' } }],
          }),
        } as Response;
      }),
    );
    const text = await describeScreenshot('aGVsbG8=', 'find the search box');
    expect(text).toBe('A file explorer with a highlighted "Reports" folder.');
    expect(captured!.url).toBe('http://localhost:1234/v1/chat/completions');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-bridge-key');
    const body = JSON.parse(captured!.bodyText);
    expect(body.model).toBe('gpt-4o');
    expect(body.stream).toBe(false);
    const user = body.messages[1].content;
    expect(user[0].text).toContain('find the search box');
    expect(user[1].image_url.url).toBe('data:image/jpeg;base64,aGVsbG8=');
  });

  it('describeScreenshot returns null on a non-2xx response', async () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.cfg.visionBridgeUrl = 'http://localhost:1234/v1';
    hoisted.cfg.visionBridgeModel = 'gpt-4o';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => '{"error":"image input is not supported"}',
      }) as Response),
    );
    expect(await describeScreenshot('aGVsbG8=')).toBeNull();
  });

  it('describeScreenshot returns null when fetch rejects', async () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.cfg.visionBridgeUrl = 'http://localhost:1234/v1';
    hoisted.cfg.visionBridgeModel = 'gpt-4o';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));
    expect(await describeScreenshot('aGVsbG8=')).toBeNull();
  });

  it('describeScreenshot returns null when the bridge is not configured', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await describeScreenshot('aGVsbG8=')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the returned description at BRIDGE_DESCRIPTION_CHAR_CAP', async () => {
    hoisted.cfg.useVisionBridge = true;
    hoisted.cfg.visionBridgeUrl = 'http://localhost:1234/v1';
    hoisted.cfg.visionBridgeModel = 'gpt-4o';
    const long = 'x'.repeat(5000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: long } }] }),
      }) as Response),
    );
    const text = await describeScreenshot('aGVsbG8=');
    expect(text!.length).toBe(1500);
  });

  it('SUBMIT_TIMEOUT_MS (readback cap) is shorter than the full bridge timeout', () => {
    expect(SUBMIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SUBMIT_TIMEOUT_MS).toBeLessThan(6000);
  });

  it('cropRegionB64 crops and re-encodes a real jpeg region', async () => {
    const w = 100;
    const h = 80;
    const px = Buffer.alloc(w * h * 3);
    const jpeg = await sharp(px, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const b64 = jpeg.toString('base64');
    const crop = await cropRegionB64(b64, 10, 10, 200, 50);
    expect(crop).not.toBeNull();
    const meta = await sharp(Buffer.from(crop!, 'base64')).metadata();
    expect(meta.width).toBe(90);
    expect(meta.height).toBe(50);
  });

  it('cropRegionB64 returns null for a garbage image', async () => {
    expect(await cropRegionB64('bm90IGFuIGltYWdl', 0, 0, 10, 10)).toBeNull();
  });
});