import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => userDataDir,
  },
}));

const settingsMock = vi.hoisted(() => ({ setSettings: vi.fn() }));
vi.mock('../electron/store/settings', () => settingsMock);

const ENV_KEYS = [
  'SPIRIT_STT_WHISPER_CLI',
  'SPIRIT_STT_GGML_MODEL',
  'SPIRIT_STT_FFMPEG',
  'SPIRIT_STT_CACHE_DIR',
  'SPIRIT_STT_MODEL',
  'APPDATA',
  'LOCALAPPDATA',
];

let root = '';
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'spirit-stt-test-'));
  userDataDir = join(root, 'userData');
  mkdirSync(userDataDir, { recursive: true });
  // Isolate the X-Whisper scan: appDataDirs() reads these first.
  process.env.APPDATA = join(root, 'roaming');
  process.env.LOCALAPPDATA = join(root, 'local');
  process.env.SPIRIT_STT_CACHE_DIR = join(root, 'hf');
  mkdirSync(process.env.SPIRIT_STT_CACHE_DIR, { recursive: true });
  delete process.env.SPIRIT_STT_WHISPER_CLI;
  delete process.env.SPIRIT_STT_GGML_MODEL;
  delete process.env.SPIRIT_STT_FFMPEG;
  delete process.env.SPIRIT_STT_MODEL;
  settingsMock.setSettings.mockClear();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function touch(file: string, bytes = 0): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes));
  return file;
}

function legacyRepo(id: string): string {
  const dir = join(
    process.env.SPIRIT_STT_CACHE_DIR as string,
    `models--Systran--faster-whisper-${id}`,
  );
  mkdirSync(join(dir, 'snapshots', 'abc'), { recursive: true });
  writeFileSync(join(dir, 'snapshots', 'abc', 'model.bin'), 'x');
  return dir;
}

describe('normalizeSttModelId', () => {
  it('maps every legacy id to turbo', async () => {
    const m = await import('../electron/voice/local-stt');
    for (const id of ['small', 'base', 'tiny', 'medium', 'large-v3', '', null, undefined, 'turbo']) {
      expect(m.normalizeSttModelId(id)).toBe('turbo');
    }
  });
});

describe('detectSttAssets', () => {
  it('returns faster when no X-Whisper assets exist', async () => {
    const m = await import('../electron/voice/local-stt');
    const assets = m.detectSttAssets();
    expect(assets.backend).toBe('faster');
    expect(assets.whisperCli).toBeNull();
    expect(assets.ggmlModel).toBeNull();
  });

  it('reuses an X-Whisper install and prefers the cuda binary', async () => {
    const wcRoot = join(root, 'whisper-cpp');
    touch(join(wcRoot, 'cpu', 'whisper-cli.exe'));
    const cuda = touch(join(wcRoot, 'cuda', 'whisper-cli.exe'));
    const model = touch(join(root, 'models', 'x-turbo', 'ggml-large-v3-turbo.bin'), 1024);
    const ffmpeg = touch(join(root, 'ffmpeg', 'ffmpeg.exe'));
    process.env.SPIRIT_STT_WHISPER_CLI = wcRoot;
    process.env.SPIRIT_STT_GGML_MODEL = model;
    process.env.SPIRIT_STT_FFMPEG = ffmpeg;

    const m = await import('../electron/voice/local-stt');
    const assets = m.detectSttAssets();
    expect(assets.backend).toBe('whispercpp');
    expect(assets.whisperCli).toBe(cuda);
    expect(assets.device).toBe('cuda');
    expect(assets.ggmlModel).toBe(model);
    expect(assets.ffmpeg).toBe(ffmpeg);
  });

  it('does not use whispercpp when the model file is missing', async () => {
    process.env.SPIRIT_STT_WHISPER_CLI = touch(join(root, 'cpu', 'whisper-cli.exe'));
    process.env.SPIRIT_STT_GGML_MODEL = join(root, 'missing.bin');
    const m = await import('../electron/voice/local-stt');
    expect(m.detectSttAssets().backend).toBe('faster');
  });
});

describe('listSttModels', () => {
  it('exposes exactly one X-Turbo row sourced from X-Whisper', async () => {
    const wc = touch(join(root, 'cuda', 'whisper-cli.exe'));
    const model = touch(join(root, 'x-turbo', 'ggml-large-v3-turbo.bin'), 2 * 1024 * 1024);
    process.env.SPIRIT_STT_WHISPER_CLI = wc;
    process.env.SPIRIT_STT_GGML_MODEL = model;

    const m = await import('../electron/voice/local-stt');
    const { models, recommendation } = m.listSttModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'turbo',
      downloaded: true,
      partial: false,
      active: true,
      recommended: true,
    });
    expect(models[0].diskMB).toBeGreaterThanOrEqual(2);
    expect(recommendation).toContain('X-Whisper');
  });

  it('reports download-needed when nothing is installed', async () => {
    const m = await import('../electron/voice/local-stt');
    const { models, recommendation } = m.listSttModels();
    expect(models).toHaveLength(1);
    expect(models[0].downloaded).toBe(false);
    expect(models[0].note).toContain('downloads once');
    expect(recommendation).toContain('downloads once');
  });

  it('recognizes the real CT2 turbo repo cache (not the old Systran id)', async () => {
    const dir = join(
      process.env.SPIRIT_STT_CACHE_DIR as string,
      'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo',
      'snapshots',
      'rev',
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.bin'), 'x');
    const stale = legacyRepo('turbo');

    const m = await import('../electron/voice/local-stt');
    const { models } = m.listSttModels();
    expect(models[0].downloaded).toBe(true);
    // listSttModels runs the one-time cleanup: the broken Systran turbo
    // directory is removed, the real CT2 cache stays.
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(dir, 'model.bin'))).toBe(true);
  });
});

describe('ensureSttCacheCleanup', () => {
  it('removes legacy Spirit caches once, keeping the live turbo cache', async () => {
    const small = legacyRepo('small');
    const base = legacyRepo('base');
    const live = join(
      process.env.SPIRIT_STT_CACHE_DIR as string,
      'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo',
    );
    mkdirSync(live, { recursive: true });

    const m = await import('../electron/voice/local-stt');
    m.ensureSttCacheCleanup();

    expect(existsSync(small)).toBe(false);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(settingsMock.setSettings).toHaveBeenCalledWith({ sttModel: 'turbo' });
    expect(existsSync(join(userDataDir, 'stt-cache-cleanup.v1'))).toBe(true);
  });

  it('does not run twice in one app session', async () => {
    const m = await import('../electron/voice/local-stt');
    m.ensureSttCacheCleanup();
    legacyRepo('small');
    m.ensureSttCacheCleanup();
    expect(existsSync(join(process.env.SPIRIT_STT_CACHE_DIR as string, 'models--Systran--faster-whisper-small'))).toBe(true);
  });
});

describe('deleteSttModel', () => {
  it('refuses to delete the X-Whisper-managed model', async () => {
    process.env.SPIRIT_STT_WHISPER_CLI = touch(join(root, 'cuda', 'whisper-cli.exe'));
    process.env.SPIRIT_STT_GGML_MODEL = touch(join(root, 'x-turbo', 'ggml-large-v3-turbo.bin'));
    const m = await import('../electron/voice/local-stt');
    const res = m.deleteSttModel('turbo');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('X-Whisper');
  });

  it('rejects unknown ids', async () => {
    const m = await import('../electron/voice/local-stt');
    expect(m.deleteSttModel('small').ok).toBe(false);
  });
});
