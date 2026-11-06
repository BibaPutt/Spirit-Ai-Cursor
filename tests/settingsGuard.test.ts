import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'Spirit',
    getVersion: () => 'test',
    getPath: (k: string) => (k === 'userData' ? join(tmpdir(), `spirit-settings-guard-${process.pid}`) : tmpdir()),
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Uint8Array) => String(Buffer.from(b)),
  },
}));

import { getSettings, getSettingsLight, setSettings } from '../electron/store/settings';

const fullOpencode = {
  apiKey: '',
  enabled: true,
  baseUrl: 'http://127.0.0.1:4096',
  model: 'mimo-v2.6-flash-free',
  availableModels: [{ id: 'a' }, { id: 'b' }],
  vision: true,
  tools: true,
  web: true,
};

function readOpencode(): Record<string, unknown> {
  return (getSettingsLight().providers as Record<string, Record<string, unknown>>).opencode;
}

describe('opencode settings guard', () => {
  it('keeps model, list and toggles through a full write', () => {
    setSettings({ providers: { opencode: fullOpencode } as never });
    const oc = readOpencode();
    expect(oc.model).toBe('mimo-v2.6-flash-free');
    expect((oc.availableModels as unknown[]).length).toBe(2);
    expect(oc.vision).toBe(true);
  });

  it('a blanked write never wipes the stored model and list', () => {
    setSettings({ providers: { opencode: fullOpencode } as never });
    // Stale/blanked snapshot arrives late (empty model + list, toggles off).
    setSettings({
      providers: {
        opencode: {
          apiKey: '',
          enabled: true,
          baseUrl: 'http://127.0.0.1:4096',
          model: '',
          availableModels: [],
          vision: false,
          tools: false,
          web: false,
        },
      } as never,
    });
    const oc = readOpencode();
    expect(oc.model).toBe('mimo-v2.6-flash-free');
    expect((oc.availableModels as unknown[]).length).toBe(2);
  });

  it('a full re-save (providers AND chipsProviders) keeps toggles', () => {    // Regression: the chips branch of the write path used to feed its bare
    // {apiKey, enabled} opencode entry into the MAIN slot writer, blanking
    // model + list + toggles on every App-level re-save.
    setSettings({ providers: { opencode: fullOpencode } as never });
    const full = getSettings();
    setSettings(JSON.parse(JSON.stringify(full)) as never);
    const oc = readOpencode();
    expect(oc.model).toBe('mimo-v2.6-flash-free');
    expect((oc.availableModels as unknown[]).length).toBe(2);
    expect(oc.vision).toBe(true);
    expect(oc.tools).toBe(true);
    expect(oc.web).toBe(true);
  });
});

describe('annotation final-pass toggle', () => {
  it('defaults off and round-trips through setSettings', () => {
    setSettings({ annotFinalPass: false });
    expect(getSettings().annotFinalPass).toBe(false);
    expect(getSettingsLight().annotFinalPass).toBe(false);
    setSettings({ annotFinalPass: true });
    expect(getSettings().annotFinalPass).toBe(true);
    expect(getSettingsLight().annotFinalPass).toBe(true);
    setSettings({ annotFinalPass: false });
  });
});
