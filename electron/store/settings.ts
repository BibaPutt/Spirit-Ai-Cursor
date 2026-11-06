import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import type {
  ChipVisibility,
  ProviderId,
  ProviderSettings,
  Settings,
  TriggerHotkey,
} from '../types';
import {
  decryptKey,
  decryptProviderKey,
  decryptProviders,
  encryptKey,
  encryptProviders,
  isEncryptionAvailable,
  probeProviderHealth,
  getProviderFailures,
  PROVIDER_IDS,
  type DecryptFailure,
  type EncryptedKey,
  type SecureProviderMap,
} from './secure-keys';
import type { ProviderHealth } from '../types';
import {
  DEFAULT_PROVIDERS,
  DEFAULT_USER_PROFILE,
  STORAGE_VERSION,
  STORE_DEFAULTS,
  defaultTriggerHotkey,
  type Schema,
} from './defaults';

// Storage architecture (v1):
//
//   - config.json is PLAIN JSON, always valid, always JSON.parse-able. This
//     is what fixed the v1.0.0 settings persistence loop: the prior build
//     handed electron-store an `encryptionKey`, so every write produced a
//     binary AES-CBC envelope on disk; the next start could not JSON.parse
//     it, the recovery branch fired, a fresh binary file was written, and
//     the loop repeated. Plain JSON eliminates that entire class of bug.
//
//   - API keys live INSIDE the JSON as safeStorage-encrypted base64 strings
//     (see ./secure-keys.ts). That gives us "encrypted at rest" without the
//     file-level encryption that caused the loop. safeStorage is used as a
//     field-level helper, not a file wrapper.
//
//   - `storageVersion` is the version of the on-disk schema. Bumped when the
//     shape changes. On read, an older / missing version triggers migration.
//
// Anything written through electron-store is now atomic (conf v10 uses the
// `atomically` package internally), so a crash mid-write cannot leave the
// file half-written.

// Schema / STORAGE_VERSION / STORE_DEFAULTS and the pure helpers
// (DEFAULT_USER_PROFILE, defaultTriggerHotkey, DEFAULT_PROVIDERS,
// PROVIDER_IDS) moved to ./defaults.ts so they stay free of Electron imports.

// Internal builds before v1.0.0-final used electron-store with a hardcoded
// envelope key derived from this string. We keep the constant ONLY so the
// recovery path can decrypt those legacy files once on upgrade. New writes
// never use it; new files are plain JSON.
const LEGACY_ENVELOPE_KEY = 'aipointer-v1-local-obfuscation';
const LEGACY_KEY_DERIVED = createHash('sha256').update(LEGACY_ENVELOPE_KEY).digest();

// DEFAULT_USER_PROFILE / defaultTriggerHotkey / DEFAULT_PROVIDERS live in
// ./defaults.ts (imported above).

const defaultWorkspace = (): string => {
  try {
    return join(app.getPath('documents'), 'Spirit');
  } catch {
    return join(process.env.HOME ?? '/tmp', 'Spirit');
  }
};

// STORE_DEFAULTS itself lives in ./defaults.ts (Electron-free so the sidecar
// can share it). The ONE Electron-dependent default is workspaceFolder:
// app.getPath('documents') needs the electron runtime, so overwrite the
// sidecar's homedir-based fallback here BEFORE the store is built (line
// below runs at module load, before buildStoreWithRecovery()). Behavior is
// byte-identical to the pre-extraction code.
STORE_DEFAULTS.workspaceFolder = defaultWorkspace();

// Heuristic: does the file on disk look like a legacy electron-store
// encrypted blob? Plain JSON starts (after whitespace) with `{` or `[`;
// anything else is treated as binary and routed through the legacy
// recovery path. We only need to look at the first non-whitespace byte.
function looksLikeBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 64);
  for (let i = 0; i < limit; i++) {
    const byte = buf[i];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte === 0x7b || byte === 0x5b) return false; // '{' or '['
    return true;
  }
  // All-whitespace or empty file: treat as plain (electron-store will write defaults).
  return false;
}

// Attempt to decrypt a legacy electron-store @ conf v10 file using the
// hardcoded LEGACY_ENVELOPE_KEY. Layout: 16-byte IV || AES-256-CBC ciphertext.
// Returns the parsed JSON object, or null if the file was not encrypted with
// this key (e.g. it was encrypted with a per-install random key from the
// broken intermediate build, which is unrecoverable).
function tryLegacyDecrypt(rawBuf: Buffer): Record<string, unknown> | null {
  if (rawBuf.length < 32) return null;
  try {
    const iv = rawBuf.subarray(0, 16);
    const ciphertext = rawBuf.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', LEGACY_KEY_DERIVED, iv);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const text = plain.toString('utf-8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function quarantine(configPath: string): string {
  const stamp = Date.now();
  const corruptedPath = `${configPath}.corrupted-${stamp}`;
  try {
    renameSync(configPath, corruptedPath);
    return corruptedPath;
  } catch (err) {
    // If we can't rename the file out of the way, we have to remove it so the
    // fresh-store construction below does not re-trigger the same parse error.
    // We log the failure but proceed; the user's data is unrecoverable in
    // either case.
    console.warn('[settings] could not rename corrupt config:', err);
    try {
      unlinkSync(configPath);
      console.warn('[settings] removed corrupt config in place');
    } catch (unlinkErr) {
      console.warn('[settings] could not remove corrupt config:', unlinkErr);
    }
    return '';
  }
}

function buildFreshStore(): Store<Schema> {
  // NO encryptionKey. The file is plain JSON. API keys inside it are
  // safeStorage-encrypted at the FIELD level via providersSecure.
  return new Store<Schema>({
    name: 'config',
    defaults: STORE_DEFAULTS,
  });
}

// Inspect the on-disk file BEFORE handing it to electron-store. This is the
// critical change vs. the v1.0.0 codepath: we never let electron-store crash
// on a non-JSON file, because we move that file out of the way first.
function buildStoreWithRecovery(): Store<Schema> {
  const configPath = join(app.getPath('userData'), 'config.json');

  if (!existsSync(configPath)) {
    // Fresh install. Nothing to migrate.
    return buildFreshStore();
  }

  let raw: Buffer;
  try {
    raw = readFileSync(configPath);
  } catch (err) {
    console.warn('[settings] could not read config.json, starting fresh:', err);
    return buildFreshStore();
  }

  // Empty file: let electron-store seed defaults.
  if (raw.length === 0) {
    return buildFreshStore();
  }

  if (looksLikeBinary(raw)) {
    // Legacy encrypted file (electron-store with encryptionKey from an old
    // build). Try to decrypt with the hardcoded key. If that fails, the file
    // was encrypted with a per-install random key from the broken build
    // and is unrecoverable.
    const migrated = tryLegacyDecrypt(raw);
    const quarantined = quarantine(configPath);
    const fresh = buildFreshStore();

    if (migrated) {
      applyMigratedValues(fresh, migrated);
      console.log(
        `[settings] migrated legacy config (old file preserved at ${
          quarantined || 'n/a'
        }).`,
      );
    } else {
      console.log(
        `[settings] could not migrate legacy config, starting fresh (old file preserved at ${
          quarantined || '(no prior file)'
        }).`,
      );
    }
    fresh.set('storageVersion', STORAGE_VERSION);
    return fresh;
  }

  // File looks like JSON. Validate up front so we can quarantine on parse
  // failure rather than letting electron-store throw inside its constructor.
  try {
    JSON.parse(raw.toString('utf-8'));
  } catch (err) {
    console.warn(
      '[settings] config.json present but unparseable, quarantining:',
      err instanceof Error ? err.message : err,
    );
    const quarantined = quarantine(configPath);
    const fresh = buildFreshStore();
    fresh.set('storageVersion', STORAGE_VERSION);
    console.log(
      `[settings] quarantined unparseable config at ${
        quarantined || '(no prior file)'
      }, starting fresh.`,
    );
    return fresh;
  }

  // Happy path: file exists and is valid JSON. electron-store reads it.
  return buildFreshStore();
}

// Copy any recognized fields from a decrypted legacy blob onto the fresh
// store. Unknown fields are ignored: this is a recovery path, not a faithful
// round-trip.
function applyMigratedValues(target: Store<Schema>, src: Record<string, unknown>): void {
  const setIf = <K extends keyof Schema>(key: K, ok: (v: unknown) => boolean): void => {
    if (key in src && ok(src[key as string])) {
      target.set(key, src[key as string] as Schema[K]);
    }
  };
  setIf('openrouterApiKey', (v) => typeof v === 'string');
  setIf('primaryModel', (v) => typeof v === 'string' && (v as string).length > 0);
  setIf('fallbackModel', (v) => typeof v === 'string' && (v as string).length > 0);
  setIf('webSearch', (v) => typeof v === 'boolean');
  setIf('workspaceFolder', (v) => typeof v === 'string' && (v as string).length > 0);
  setIf('providers', (v) => !!v && typeof v === 'object');
  setIf('providersSecure', (v) => v === null || (typeof v === 'object' && v !== null));
  setIf('autoApproveTools', (v) => typeof v === 'boolean');
  setIf('memorySaveEnabled', (v) => typeof v === 'boolean');
  setIf('contextMemoryEnabled', (v) => typeof v === 'boolean');
  setIf('maxContextTokens', (v) => typeof v === 'number' && Number.isFinite(v));
  setIf('autoContext', (v) => typeof v === 'boolean');
  setIf('annotFinalPass', (v) => typeof v === 'boolean');
  setIf('voiceLanguage', (v) => typeof v === 'string');
  setIf('sttEngine', (v) => v === 'auto' || v === 'local' || v === 'cloud');
  setIf('sttModel', (v) => typeof v === 'string');
  setIf('sttInitialPrompt', (v) => typeof v === 'string');
  setIf('sttWordOverrides', (v) => typeof v === 'string');
  setIf(
    'triggerHotkey',
    (v) => v === 'MetaRight' || v === 'CtrlRight' || v === 'AltRight' || v === 'ShiftRight',
  );
  setIf('userProfile', (v) => !!v && typeof v === 'object');
  setIf('personalizePrompts', (v) => typeof v === 'boolean');
  setIf('dismissOnDoubleClick', (v) => typeof v === 'boolean');
  setIf('audioMode', (v) => typeof v === 'boolean');
  setIf('themePreference', (v) => v === 'system' || v === 'light' || v === 'dark');
  setIf('mouseWiggleEnabled', (v) => typeof v === 'boolean');
  setIf('chipVisibility', (v) => v === 'both' || v === 'voice' || v === 'type' || v === 'off');
  setIf('chipsSource', (v) => v === 'smart' || v === 'premade' || v === 'custom');
  setIf('customChips', (v) => Array.isArray(v));
  setIf('reducedTransparency', (v) => typeof v === 'boolean');
  setIf('screenshotCropW', (v) => typeof v === 'number' && Number.isFinite(v));
  setIf('screenshotCropH', (v) => typeof v === 'number' && Number.isFinite(v));
  setIf('annotOffsetX', (v) => typeof v === 'number' && Number.isFinite(v));
  setIf('annotOffsetY', (v) => typeof v === 'number' && Number.isFinite(v));
  setIf('notificationsEnabled', (v) => typeof v === 'boolean');
  setIf('clearMemoryOnQuit', (v) => typeof v === 'boolean');
  setIf('customShortcuts', (v) => !!v && typeof v === 'object' && !Array.isArray(v));
  setIf(
    'enabledSkills',
    (v) => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')),
  );
}

// Opportunistic GC: delete quarantined config files older than 7 days so the
// user's Application Support folder does not accumulate copies forever. Not
// security-critical; we just don't want a janitor task running over them.
function cleanupOldQuarantinedConfigs(): void {
  try {
    const userData = app.getPath('userData');
    if (!existsSync(userData)) return;
    const entries = readdirSync(userData);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith('config.json.corrupted-')) continue;
      const full = join(userData, name);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > sevenDaysMs) {
          unlinkSync(full);
          console.log(`[settings] removed stale quarantined config: ${name}`);
        }
      } catch {
        /* ignore: file vanished or unreadable */
      }
    }
  } catch {
    /* ignore: userData not accessible, nothing we can do */
  }
}

const store = buildStoreWithRecovery();

// getSettings() rebuilds the whole settings object (≈50 store reads) and is
// called from the input hot path in trigger.ts — every mouse move, keydown
// and keyup. A short TTL memo makes that read effectively free; the store
// change subscription below invalidates it the instant anything is written,
// so a mutation is never hidden behind the TTL.
const SETTINGS_MEMO_TTL_MS = 400;
let memoizedSettings: Settings | null = null;
let memoizedSettingsAt = 0;

// getSettingsLight() rebuilds the same ~50-read view (minus the encrypted
// keys) and runs on every trigger/submit/capture path — same TTL, same
// invalidation. Callers treat the result as read-only; IPC serializes it.
const SETTINGS_LIGHT_MEMO_TTL_MS = 400;
let memoizedSettingsLight: Settings | null = null;
let memoizedSettingsLightAt = 0;

export function invalidateSettingsCache(): void {
  memoizedSettings = null;
  memoizedSettingsAt = 0;
  memoizedSettingsLight = null;
  memoizedSettingsLightAt = 0;
}

store.onDidAnyChange(() => invalidateSettingsCache());

// Schema v1 → v2 migration. Existing v1.0.0 users already configured the
// app, so no wizard is shown on upgrade. Fresh installs land here with
// storageVersion already at 2 (via defaults).
(() => {
  const onDisk = (store.get('storageVersion') as number | undefined) ?? 0;
  if (onDisk >= STORAGE_VERSION) return;
  if (onDisk < 2) {
    // Fill any remaining v2 defaults that are absent.
    const v2Fields: (keyof Schema)[] = [
      'mouseWiggleEnabled',
      'reducedTransparency',
      'screenshotCropW',
      'screenshotCropH',
    ];
    for (const k of v2Fields) {
      if (typeof store.get(k) === 'undefined' || store.get(k) === null) {
        store.set(k, STORE_DEFAULTS[k] as Schema[typeof k]);
      }
    }
  }
  // Schema v2 → v3 migration. Add notificationsEnabled, clearMemoryOnQuit,
  // customShortcuts with sensible defaults for existing users.
  if (onDisk < 3) {
    const v3Fields: (keyof Schema)[] = [
      'notificationsEnabled',
      'clearMemoryOnQuit',
      'customShortcuts',
    ];
    for (const k of v3Fields) {
      if (typeof store.get(k) === 'undefined' || store.get(k) === null) {
        store.set(k, STORE_DEFAULTS[k] as Schema[typeof k]);
      }
    }
  }
  // Schema v3 → v4 migration. Glass look replaces the reducedTransparency
  // boolean. reducedTransparency=true (user wanted solid) becomes
  // clear/60; everyone else lands on Hermes defaults glass/29.
  if (onDisk < 4) {
    const reduced = store.get('reducedTransparency') === true;
    store.set('glassMode', reduced ? 'clear' : STORE_DEFAULTS.glassMode);
    store.set('glassIntensity', reduced ? 60 : STORE_DEFAULTS.glassIntensity);
    if (typeof store.get('glassFade') !== 'number') store.set('glassFade', STORE_DEFAULTS.glassFade);
    if (typeof store.get('glassMaterial') !== 'string') {
      store.set('glassMaterial', STORE_DEFAULTS.glassMaterial);
    }
    if (typeof store.get('glassScope') !== 'string') store.set('glassScope', STORE_DEFAULTS.glassScope);
  }
  // Schema v4 → v5 migration. Wiggle sensitivity, defaulting to `high`
  // (the original tuning) so existing users feel no change.
  if (onDisk < 5) {
    if (typeof store.get('wiggleSensitivity') !== 'string') {
      store.set('wiggleSensitivity', STORE_DEFAULTS.wiggleSensitivity);
    }
  }
  // Schema v5 → v6 migration. Tint slider rescaled: old 25 = new 100
  // (the slider now spans the old 0–25 frost range). Multiply saved
  // values ×4 (clamped) so existing users see zero visual change.
  if (onDisk < 6) {
    const old = store.get('glassIntensity');
    if (typeof old === 'number' && Number.isFinite(old)) {
      store.set('glassIntensity', Math.max(0, Math.min(100, Math.round(old * 4))));
    } else {
      store.set('glassIntensity', STORE_DEFAULTS.glassIntensity);
    }
  }
  store.set('storageVersion', STORAGE_VERSION);
})();

// Make sure storageVersion is set on every install path (fresh, migrated,
// or quarantine fallback). Future migrations key off this.
if (store.get('storageVersion') !== STORAGE_VERSION) {
  store.set('storageVersion', STORAGE_VERSION);
}

cleanupOldQuarantinedConfigs();

// Best-effort migration: if a previous build stored a real key in
// `providers[*].apiKey` (plaintext), move it into the encrypted slot once
// and clear the plaintext. Same for the legacy openrouterApiKey field.
(() => {
  const secure = store.get('providersSecure');
  const legacyProviders = store.get('providers') ?? DEFAULT_PROVIDERS;
  const legacyOR = store.get('openrouterApiKey');

  // If we already have a secure map, only check that we don't still have
  // plaintext keys hanging around; clear them.
  if (secure) {
    let needsClear = false;
    const cleaned: Record<ProviderId, ProviderSettings> = { ...legacyProviders };
    for (const id of Object.keys(cleaned) as ProviderId[]) {
      if (cleaned[id]?.apiKey) {
        cleaned[id] = { ...cleaned[id], apiKey: '' };
        needsClear = true;
      }
    }
    if (legacyOR) {
      store.set('openrouterApiKey', '');
      needsClear = true;
    }
    if (needsClear) store.set('providers', cleaned);
    return;
  }

  // Otherwise migrate.
  const plain: Record<ProviderId, ProviderSettings> = { ...DEFAULT_PROVIDERS, ...legacyProviders };
  if (legacyOR && !plain.openrouter?.apiKey) {
    plain.openrouter = { apiKey: legacyOR, enabled: plain.openrouter?.enabled ?? true };
  }
  const encrypted = encryptProviders(plain);
  store.set('providersSecure', encrypted);

  // Clear plaintext copies.
  const cleared: Record<ProviderId, ProviderSettings> = { ...plain };
  for (const id of Object.keys(cleared) as ProviderId[]) {
    cleared[id] = { ...cleared[id], apiKey: '' };
  }
  store.set('providers', cleared);
  if (legacyOR) store.set('openrouterApiKey', '');

  if (!isEncryptionAvailable()) {
    console.warn(
      '[settings] safeStorage encryption is not available on this platform. ' +
        'API keys are stored with base64-only encoding. Set up libsecret / ' +
        'KWallet to enable encryption.',
    );
  }
})();

// Startup probe so we detect a Windows-DPAPI / macOS-
// keychain "key on disk but unreadable" state BEFORE the user runs a
// query. The result lands in `getProviderFailures()` and is surfaced
// via the providers:health IPC.
//
// On Windows: config.json lives at %APPDATA%\Spirit\config.json. The
// ciphertext is DPAPI-wrapped per-user. If decryption fails on startup
// after the user has configured a key, the most likely culprits are:
// roamed profile path mismatch, password change since the key was
// wrapped, or running under a different Windows user.
//
// IMPORTANT: this MUST be called only after `app.whenReady()` — before
// that, Windows reports safeStorage encryption as unavailable and the
// probe would falsely flag every stored key as broken. `main.ts` invokes
// it from `setup()`; the module-load side-effect was removed for that
// reason.
export function runProviderHealthProbe(): void {
  try {
    probeProviderHealth(store.get('providersSecure'));
  } catch (err) {
    console.warn('[settings] provider health probe threw:', err);
  }
}

// Local AI (OpenAI-compatible server) provider config — the NON-secret
// fields (base URL, model, detected model list, capability toggles). These
// live in the plain `providers` map because, unlike API keys, they are not
// sensitive and should not round-trip through safeStorage. `enabled` and the
// optional `apiKey` still live in providersSecure like every other provider.
function readLocalAiConfig(): ProviderSettings {
  return readLocalAiConfigFrom('providers');
}

// Chips-only Local AI plain config — the second, independent Local AI slot
// used when chip generation is pointed at its own provider set.
function readChipsLocalAiConfig(): ProviderSettings {
  return readLocalAiConfigFrom('chipsLocalAiConfig');
}

function readLocalAiConfigFrom(storeKey: 'providers' | 'chipsLocalAiConfig'): ProviderSettings {
  const raw =
    storeKey === 'providers'
      ? (store.get('providers') as Record<string, ProviderSettings> | undefined)?.['localai']
      : (store.get('chipsLocalAiConfig') as ProviderSettings | undefined);
  return {
    apiKey: '',
    enabled: false,
    baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl : '',
    model: typeof raw?.model === 'string' ? raw.model : '',
    availableModels: Array.isArray(raw?.availableModels) ? raw.availableModels : [],
    vision: raw?.vision === true,
    tools: raw?.tools === true,
    web: raw?.web === true,
    contextLength:
      typeof raw?.contextLength === 'number' && Number.isFinite(raw.contextLength)
        ? raw.contextLength
        : undefined,
    useVisionBridge: raw?.useVisionBridge === true,
    visionBridgeUrl: typeof raw?.visionBridgeUrl === 'string' ? raw.visionBridgeUrl : '',
    visionBridgeModel:
      typeof raw?.visionBridgeModel === 'string' ? raw.visionBridgeModel : '',
  };
}

function writeLocalAiConfigImpl(cfg: ProviderSettings): void {
  const providers = (store.get('providers') ?? {}) as Record<string, ProviderSettings>;
  providers.localai = normalizeLocalAiConfig(cfg);
  store.set('providers', providers);
}

// Chips-only Local AI plain config write (parallel to writeLocalAiConfig but
// into the independent chips slot).
function writeChipsLocalAiConfig(cfg: ProviderSettings): void {
  store.set('chipsLocalAiConfig', normalizeLocalAiConfig(cfg));
}

function normalizeLocalAiConfig(cfg: ProviderSettings): ProviderSettings {
  return {
    apiKey: '',
    enabled: false,
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
    model: typeof cfg.model === 'string' ? cfg.model : '',
    availableModels: Array.isArray(cfg.availableModels) ? cfg.availableModels : [],
    vision: cfg.vision === true,
    tools: cfg.tools === true,
    web: cfg.web === true,
    contextLength:
      typeof cfg.contextLength === 'number' && Number.isFinite(cfg.contextLength)
        ? cfg.contextLength
        : undefined,
    useVisionBridge: cfg.useVisionBridge === true,
    visionBridgeUrl: typeof cfg.visionBridgeUrl === 'string' ? cfg.visionBridgeUrl : '',
    visionBridgeModel:
      typeof cfg.visionBridgeModel === 'string' ? cfg.visionBridgeModel : '',
  };
}

// Backend-only: the current Local AI server config (base URL, model,
// detected models, capability toggles). Empty baseUrl means "not configured".
export function getLocalAiConfig(): ProviderSettings {
  return readLocalAiConfig();
}

// Backend-only: persist the Local AI server config (base URL, model,
// capability toggles, and the vision bridge plain fields). API keys are NOT
// part of this write — they go through the encrypted providersSecure / key
// helpers so a config save can never touch ciphertext.
export function writeLocalAiConfig(cfg: ProviderSettings): void {
  writeLocalAiConfigImpl(cfg);
}

// Backend-only: the chips-only Local AI server config — the independent slot
// used when chip generation points at its own provider set. Mirrors
// getLocalAiConfig but reads the chips slot so the two never collide.
export function getChipsLocalAiConfig(): ProviderSettings {
  return readChipsLocalAiConfig();
}

// opencode config (local server base URL + optional agent/model). Non-secret
// settings in the plain `providers` map like Local AI. No `sk_…` key is
// required — opencode serve is an unauthenticated local server.
export function getOpencodeConfig(): ProviderSettings {
  const raw = (store.get('providers') as Record<string, ProviderSettings> | undefined)?.[
    'opencode'
  ];
  return {
    apiKey: '',
    enabled: raw?.enabled === true,
    baseUrl: typeof raw?.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : 'http://127.0.0.1:4096',
    model: typeof raw?.model === 'string' ? raw.model : '',
    availableModels: Array.isArray(raw?.availableModels) ? raw.availableModels : [],
    vision: raw?.vision === true,
    tools: raw?.tools === true,
    web: raw?.web === true,
    contextLength:
      typeof raw?.contextLength === 'number' && Number.isFinite(raw.contextLength)
        ? raw.contextLength
        : undefined,
  };
}

function writeOpencodeConfig(cfg: ProviderSettings): void {
  const providers = (store.get('providers') ?? {}) as Record<string, ProviderSettings>;
  const stored = providers.opencode;
  // Blank-over-full guard: no UI path legitimately produces an empty model +
  // empty list over stored values (the model dropdown always carries a pick;
  // an empty list only means "never detected"). A stale/blanked snapshot must
  // never wipe a good stored config — keep stored model + list in that case.
  // Explicit controls (enabled, base URL, toggles) always apply.
  const incomingModel = typeof cfg.model === 'string' ? cfg.model : '';
  const incomingModels = Array.isArray(cfg.availableModels) ? cfg.availableModels : [];
  providers.opencode = {
    apiKey: '',
    enabled: cfg.enabled === true,
    baseUrl: typeof cfg.baseUrl === 'string' && cfg.baseUrl ? cfg.baseUrl : 'http://127.0.0.1:4096',
    model: incomingModel || stored?.model || '',
    availableModels: incomingModels.length > 0 ? incomingModels : (stored?.availableModels ?? []),
    vision: cfg.vision === true,
    tools: cfg.tools === true,
    web: cfg.web === true,
    contextLength:
      typeof cfg.contextLength === 'number' && Number.isFinite(cfg.contextLength)
        ? cfg.contextLength
        : undefined,
  };
  store.set('providers', providers);
}

// Whether an opencode server is configured and usable WITHOUT a stored API
// key — configured by its base URL, not a key (same rule as Local AI).
export function hasOpencodeServer(): boolean {
  return (getOpencodeConfig().baseUrl ?? '').trim().length > 0;
}

// Whether a Local AI server is configured and usable WITHOUT a stored API
// key — the localai provider is considered "configured" by its base URL,
// not by a key. Router chain resolution and the HasAnyConfiguredProvider
// IPC use this instead of hasProviderKey('localai').
export function hasLocalAiServer(): boolean {
  return (readLocalAiConfig().baseUrl ?? '').trim().length > 0;
}

export function getProvidersHealth(): ProviderHealth[] {
  const failures = getProviderFailures();
  const secure = store.get('providersSecure');
  const out: ProviderHealth[] = [];
  for (const id of PROVIDER_IDS) {
    const e = secure?.[id];
    const hasKey = !!e?.ciphertext;
    const reason = failures[id] as DecryptFailure | undefined;
    out.push({
      provider: id,
      hasKey,
      enabled: !!e?.enabled,
      brokenDecrypt: hasKey && !!reason && reason !== 'none',
      reason: reason ?? 'none',
    });
  }
  return out;
}

// Runtime-resolved audioMode is the stored boolean; no per-mode split.

// Suggestion-chip visibility, migrated from the pre-1.3 boolean `suggestChips`
// (true meant 'both', false meant 'off'). New installs and untouched users get
// 'both' — chips behave exactly as they always did until someone opens the new
// dropdown.
function getChipVisibility(): ChipVisibility {
  const v = store.get('chipVisibility') as ChipVisibility | undefined;
  if (v === 'both' || v === 'voice' || v === 'type' || v === 'off') return v;
  if (store.has('suggestChips')) {
    return store.get('suggestChips') ? 'both' : 'off';
  }
  return 'both';
}

// Where suggestion chips come from. Defaults to 'smart' so existing installs
// behave exactly as before.
export function getChipsSource(): 'smart' | 'premade' | 'custom' {
  const v = store.get('chipsSource') as string | undefined;
  return v === 'premade' || v === 'custom' ? v : 'smart';
}

// User-defined chips for chipsSource 'custom'. Sanitized: max 6 entries,
// label + prompt required, icon optional.
export function readCustomChips(): Array<{ label: string; prompt: string; icon?: string }> {
  const raw = store.get('customChips');
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; prompt: string; icon?: string }> = [];
  for (const it of raw.slice(0, 6)) {
    if (it && typeof it.label === 'string' && typeof it.prompt === 'string'
      && it.label.trim() && it.prompt.trim()) {
      const chip: { label: string; prompt: string; icon?: string } = {
        label: it.label.trim().slice(0, 45),
        prompt: it.prompt.trim().slice(0, 400),
      };
      if (typeof it.icon === 'string' && it.icon.trim()) chip.icon = it.icon.trim().slice(0, 24);
      out.push(chip);
    }
  }
  return out;
}

// Whether chip generation reuses the main provider chain. False means the
// chips-only provider set (getChipsSettingsLight) is used instead.
export function getChipsUseMainProvider(): boolean {
  return (store.get('chipsUseMainProvider') as boolean | undefined) ?? true;
}

// Chips-only provider map. `decryptKeys` controls whether API keys come back
// plaintext (main-process getSettings-style read) or as empty-with-hasKey
// flags (renderer-safe read). Local AI's non-secret config always merges from
// the independent chipsLocalAiConfig slot.
function getChipsProviders(decryptKeys: boolean): Record<ProviderId, ProviderSettings> {
  const secure = store.get('chipsProvidersSecure');
  const localCfg = readChipsLocalAiConfig();
  if (decryptKeys) {
    const providers = decryptProviders(secure);
    providers.localai = {
      ...localCfg,
      apiKey: providers.localai?.apiKey ?? '',
      enabled: providers.localai?.enabled ?? false,
    };
    return providers;
  }
  const providers = {} as Record<ProviderId, ProviderSettings>;
  for (const id of PROVIDER_IDS) {
    const entry = secure?.[id];
    providers[id] = {
      apiKey: '',
      hasKey: !!entry?.ciphertext,
      ...(id === 'localai' ? localCfg : {}),
      enabled: !!entry?.enabled,
    };
  }
  return providers;
}

// Backend-only: the chips-only provider map (decrypted keys) — parallel to
// getSettings()'s `providers`.
export function getChipsProvidersFull(): Record<ProviderId, ProviderSettings> {
  return getChipsProviders(true);
}

// Lazy / renderer-safe chips provider read: no keychain touch, apiKey always
// empty, hasKey flags for the "Key saved" badge. Used by the chips provider
// UI and by router chain resolution.
export function getChipsSettingsLight(): {
  useMain: boolean;
  providers: Record<ProviderId, ProviderSettings>;
} {
  return { useMain: getChipsUseMainProvider(), providers: getChipsProviders(false) };
}

// Stable fingerprint of the chips provider chain — which provider set chip
// generation currently resolves to. Used as part of the chips cache key so a
// provider switch invalidates chips cached under the old chain.
export function getChipsChainFingerprint(): string {
  const { useMain, providers } = getChipsSettingsLight();
  if (useMain) return 'main';
  const parts = PROVIDER_IDS.map((id) => {
    const p = providers[id];
    if (!p) return `${id}:off`;
    if (id === 'localai') {
      const base = (p.baseUrl ?? '').trim();
      return `${id}:${p.enabled && base ? base : 'off'}`;
    }
    return `${id}:${p.enabled && p.hasKey ? 'on' : 'off'}`;
  });
  return parts.join('|');
}

// Backend-only: decrypt a single chips-only provider's API key on demand.
// Mirrors getDecryptedProviderKey but reads the chips provider map.
export function getDecryptedChipsProviderKey(id: ProviderId): string {
  const secure = store.get('chipsProvidersSecure');
  if (!secure) return '';
  const entry = secure[id];
  if (!entry || !entry.ciphertext) return '';
  return decryptProviderKey(entry, id);
}

export function getSettings(): Settings {
  const now = Date.now();
  if (memoizedSettings && now - memoizedSettingsAt < SETTINGS_MEMO_TTL_MS) {
    return memoizedSettings;
  }
  const secure = store.get('providersSecure');
  const providers = decryptProviders(secure);
  // Local AI's non-secret config lives in the plain map; merge it so the
  // full Settings view carries the same provider object as the light view.
  // `enabled` and `apiKey` come from the encrypted map, config fields from
  // the plain map.
  providers.localai = {
    ...readLocalAiConfig(),
    apiKey: providers.localai?.apiKey ?? '',
    enabled: providers.localai?.enabled ?? false,
  };
  providers.opencode = {
    ...getOpencodeConfig(),
    apiKey: providers.opencode?.apiKey ?? '',
    enabled: providers.opencode?.enabled ?? false,
  };
  const next: Settings = {
    openrouterApiKey: providers.openrouter?.apiKey ?? '',
    primaryModel: store.get('primaryModel'),
    fallbackModel: store.get('fallbackModel'),
    webSearch: store.get('webSearch'),
    workspaceFolder: store.get('workspaceFolder'),
    providers,
    autoApproveTools: store.get('autoApproveTools'),
    memorySaveEnabled: store.get('memorySaveEnabled'),
    contextMemoryEnabled: store.get('contextMemoryEnabled') ?? false,
    maxContextTokens: store.get('maxContextTokens'),
    autoContext: store.get('autoContext') ?? true,
    annotFinalPass: store.get('annotFinalPass') ?? false,
    voiceLanguage: store.get('voiceLanguage') ?? 'auto',
    sttEngine: (store.get('sttEngine') as 'auto' | 'local' | 'cloud' | undefined) ?? 'auto',
    sttModel: (store.get('sttModel') as string | undefined) ?? '',
    sttInitialPrompt: (store.get('sttInitialPrompt') as string | undefined) ?? '',
    sttWordOverrides: (store.get('sttWordOverrides') as string | undefined) ?? '',
    triggerHotkey: store.get('triggerHotkey') ?? defaultTriggerHotkey(),
    userProfile: { ...DEFAULT_USER_PROFILE, ...(store.get('userProfile') ?? {}) },
    personalizePrompts: store.get('personalizePrompts') ?? false,
    dismissOnDoubleClick: store.get('dismissOnDoubleClick') ?? true,
    audioMode: store.get('audioMode') ?? false,
    themePreference:
      (store.get('themePreference') as 'system' | 'light' | 'dark' | undefined) ?? 'system',
    mouseWiggleEnabled: store.get('mouseWiggleEnabled') ?? true,
    wiggleSensitivity:
      (store.get('wiggleSensitivity') as 'low' | 'normal' | 'high' | undefined) ?? 'high',
    chipVisibility: getChipVisibility(),
    chipsUseMainProvider: getChipsUseMainProvider(),
    chipsSource: getChipsSource(),
    customChips: readCustomChips(),
    chipsProviders: getChipsProviders(true),
    reducedTransparency: store.get('reducedTransparency') ?? false,
    glassMode: (store.get('glassMode') as 'clear' | 'glass' | undefined) ?? 'glass',
    glassIntensity: store.get('glassIntensity') ?? 100,
    glassFade: store.get('glassFade') ?? 0,
    glassMaterial:
      (store.get('glassMaterial') as Settings['glassMaterial'] | undefined) ?? 'under-window',
    glassScope: (store.get('glassScope') as 'window' | 'sidebar' | undefined) ?? 'sidebar',
    screenshotCropW: store.get('screenshotCropW') ?? 512,
    screenshotCropH: store.get('screenshotCropH') ?? 384,
    annotOffsetX: store.get('annotOffsetX') ?? 0,
    annotOffsetY: store.get('annotOffsetY') ?? 0,
    calendarProvider:
      (store.get('calendarProvider') as 'google' | 'outlook' | undefined) ?? 'google',
    notificationsEnabled: store.get('notificationsEnabled') ?? true,
    clearMemoryOnQuit: store.get('clearMemoryOnQuit') ?? false,
    ghostMode: store.get('ghostMode') ?? true,
    ghostHideTaskbar: store.get('ghostHideTaskbar') ?? true,
    customShortcuts: (store.get('customShortcuts') as Record<string, string>) ?? {},
    permissionRules: readPermissionRules(),
  };
  memoizedSettings = next;
  memoizedSettingsAt = now;
  return next;
}

// Backend-only: per-tool allow/deny rules. Unknown values are dropped;
// missing map means no rules.
export function getPermissionRules(): Record<string, 'allow' | 'deny'> {
  return readPermissionRules();
}

function readPermissionRules(): Record<string, 'allow' | 'deny'> {
  const raw = store.get('permissionRules') as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, 'allow' | 'deny'> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === 'allow' || v === 'deny') out[k] = v;
  }
  return out;
}

export function setPermissionRule(tool: string, rule: 'allow' | 'deny' | null): void {
  const next = readPermissionRules();
  if (rule === null) delete next[tool];
  else next[tool] = rule;
  store.set('permissionRules', next);
}
// shape but provider apiKey strings are always empty. The renderer-facing
// IPC handler uses this to avoid triggering keychain prompts at startup or
// during settings reads. When the user needs to display an existing key
// (Show button), the renderer issues a separate explicit IPC.
export function getSettingsLight(): Settings {
  const now = Date.now();
  if (memoizedSettingsLight && now - memoizedSettingsLightAt < SETTINGS_LIGHT_MEMO_TTL_MS) {
    return memoizedSettingsLight;
  }
  const secure = store.get('providersSecure');
  const localAiCfg = readLocalAiConfig();
  const providers = {} as Record<ProviderId, ProviderSettings>;
  for (const id of PROVIDER_IDS) {
    const entry = secure?.[id];
    providers[id] = {
      apiKey: '',
      hasKey: !!entry?.ciphertext,
      // Local AI config fields are public (no keychain round-trip needed);
      // `enabled` stays sourced from the encrypted map like every provider.
      ...(id === 'localai' ? localAiCfg : {}),
      // opencode config fields are public too (local server, no key).
      ...(id === 'opencode' ? getOpencodeConfig() : {}),
      enabled: !!entry?.enabled,
    };
  }
  const next: Settings = {
    openrouterApiKey: '',
    primaryModel: store.get('primaryModel'),
    fallbackModel: store.get('fallbackModel'),
    webSearch: store.get('webSearch'),
    workspaceFolder: store.get('workspaceFolder'),
    providers,
    autoApproveTools: store.get('autoApproveTools'),
    memorySaveEnabled: store.get('memorySaveEnabled'),
    contextMemoryEnabled: store.get('contextMemoryEnabled') ?? false,
    maxContextTokens: store.get('maxContextTokens'),
    autoContext: store.get('autoContext') ?? true,
    annotFinalPass: store.get('annotFinalPass') ?? false,
    voiceLanguage: store.get('voiceLanguage') ?? 'auto',
    sttEngine: (store.get('sttEngine') as 'auto' | 'local' | 'cloud' | undefined) ?? 'auto',
    sttModel: (store.get('sttModel') as string | undefined) ?? '',
    sttInitialPrompt: (store.get('sttInitialPrompt') as string | undefined) ?? '',
    sttWordOverrides: (store.get('sttWordOverrides') as string | undefined) ?? '',
    triggerHotkey: store.get('triggerHotkey') ?? defaultTriggerHotkey(),
    userProfile: { ...DEFAULT_USER_PROFILE, ...(store.get('userProfile') ?? {}) },
    personalizePrompts: store.get('personalizePrompts') ?? false,
    dismissOnDoubleClick: store.get('dismissOnDoubleClick') ?? true,
    audioMode: store.get('audioMode') ?? false,
    themePreference:
      (store.get('themePreference') as 'system' | 'light' | 'dark' | undefined) ?? 'system',
    mouseWiggleEnabled: store.get('mouseWiggleEnabled') ?? true,
    wiggleSensitivity:
      (store.get('wiggleSensitivity') as 'low' | 'normal' | 'high' | undefined) ?? 'high',
    chipVisibility: getChipVisibility(),
    chipsUseMainProvider: getChipsUseMainProvider(),
    chipsSource: getChipsSource(),
    customChips: readCustomChips(),
    chipsProviders: getChipsProviders(false),
    reducedTransparency: store.get('reducedTransparency') ?? false,
    glassMode: (store.get('glassMode') as 'clear' | 'glass' | undefined) ?? 'glass',
    glassIntensity: store.get('glassIntensity') ?? 100,
    glassFade: store.get('glassFade') ?? 0,
    glassMaterial:
      (store.get('glassMaterial') as Settings['glassMaterial'] | undefined) ?? 'under-window',
    glassScope: (store.get('glassScope') as 'window' | 'sidebar' | undefined) ?? 'sidebar',
    screenshotCropW: store.get('screenshotCropW') ?? 512,
    screenshotCropH: store.get('screenshotCropH') ?? 384,
    annotOffsetX: store.get('annotOffsetX') ?? 0,
    annotOffsetY: store.get('annotOffsetY') ?? 0,
    calendarProvider:
      (store.get('calendarProvider') as 'google' | 'outlook' | undefined) ?? 'google',
    notificationsEnabled: store.get('notificationsEnabled') ?? true,
    clearMemoryOnQuit: store.get('clearMemoryOnQuit') ?? false,
    ghostMode: store.get('ghostMode') ?? true,
    ghostHideTaskbar: store.get('ghostHideTaskbar') ?? true,
    customShortcuts: (store.get('customShortcuts') as Record<string, string>) ?? {},
    permissionRules: readPermissionRules(),
  };
  memoizedSettingsLight = next;
  memoizedSettingsLightAt = now;
  return next;
}

// Plain-store input tuning for the uiohook hot path (mousemove fires at
// pointer rate). getSettings()/getSettingsLight() rebuild a ~50-key view per
// call — memoized, but still a rebuild every TTL while the pointer moves.
// These four keys never live in the encrypted map and store.get is an
// in-memory read, so a direct fetch is always fresh and effectively free.
export type InputTuning = {
  mouseWiggleEnabled: boolean;
  wiggleSensitivity: 'low' | 'normal' | 'high' | undefined;
  triggerHotkey: string;
  dismissOnDoubleClick: boolean;
};

export function getInputTuning(): InputTuning {
  return {
    mouseWiggleEnabled: store.get('mouseWiggleEnabled') ?? true,
    wiggleSensitivity:
      (store.get('wiggleSensitivity') as 'low' | 'normal' | 'high' | undefined) ?? 'high',
    triggerHotkey: store.get('triggerHotkey') ?? defaultTriggerHotkey(),
    dismissOnDoubleClick: store.get('dismissOnDoubleClick') ?? true,
  };
}

// Plain-store reads for the ghost-mode startup path. No keychain, no memo,
// safe to call before app.whenReady() and from the global-shortcut handler.
export function getGhostMode(): boolean {
  return store.get('ghostMode') ?? true;
}

export function getGhostHideTaskbar(): boolean {
  return store.get('ghostHideTaskbar') ?? true;
}

// Backend-only: decrypt a single provider's API key on demand. Triggers
// safeStorage.decryptString — keychain prompt fires here the first time
// after launch for users who have a saved key.
export function getDecryptedProviderKey(id: ProviderId): string {
  const secure = store.get('providersSecure');
  if (!secure) return '';
  const entry = secure[id];
  if (!entry || !entry.ciphertext) return '';
  // Provider-aware decrypt: a SUCCESS here clears any stale per-provider
  // failure (e.g. a false "keychain-unavailable" from an early probe), so
  // the health banner disappears the moment the key actually works.
  return decryptProviderKey(entry, id);
}

// Whether the user has a stored API key for a given provider. Does NOT
// decrypt — safe to call from UI paths.
export function hasProviderKey(id: ProviderId): boolean {
  const secure = store.get('providersSecure');
  if (!secure) return false;
  const e = secure[id];
  return !!e && !!e.ciphertext;
}

// Vision bridge key store. The bridge's API key is NOT a provider key — it
// may belong to a different service than any provider (a local llama.cpp with
// mmproj, a separate gateway, ...). It lives in its own encrypted slot so it
// gets the same safeStorage treatment as provider keys without becoming a
// ProviderId (which would surface it as a provider card in Settings).
export function hasVisionBridgeKey(): boolean {
  const e = store.get('visionBridgeSecure') as EncryptedKey | undefined | null;
  return !!e && !!e.ciphertext;
}

export function getVisionBridgeKey(): string {
  return decryptKey(store.get('visionBridgeSecure') as EncryptedKey | undefined | null);
}

export function setVisionBridgeKey(key: string): void {
  store.set('visionBridgeSecure', encryptKey(key ?? ''));
}

// SURGICAL provider patch writer. Operates directly on the ENCRYPTED
// store — never decrypts existing keys. This is what allows Spirit
// to be robust under dev-mode safeStorage flakiness on macOS, where
// the ad-hoc-signed dev build sometimes fails to decrypt entries
// encrypted by an earlier launch.
//
// Old behavior (pre-fix):
//   1. Decrypt ALL providers
//   2. Merge patch into the plaintext map
//   3. Re-encrypt ALL providers back into the store
// Failure mode: if step 1 returned empty for any provider (decryption
// fail), step 3 wrote that empty back as empty ciphertext → key wiped.
// On every successful Settings save the keys would silently disappear.
//
// New behavior:
//   - Existing providersSecure entries are PRESERVED byte-for-byte
//     unless a specific field is being changed.
//   - Only when `incoming.apiKey` is a non-empty string do we touch
//     the ciphertext for that provider — encrypting JUST the new key.
//   - When only `incoming.enabled` is being changed, we update the
//     enabled flag in place without touching the ciphertext at all.
// Net: no decrypt → no chance of accidental wipe → keys survive dev
// reloads, settings saves, mode switches, etc. The SAME write path backs the
// chips-only provider map (chipsProvidersSecure + chipsLocalAiConfig), so the
// chips provider keys get identical anti-wipe guarantees.
function writeProvidersFromPatch(
  patch: Partial<Record<ProviderId, ProviderSettings>>,
): void {
  writeProvidersFromPatchTo('providersSecure', 'providers', writeLocalAiConfig, patch);
}

function writeChipsProvidersFromPatch(
  patch: Partial<Record<ProviderId, ProviderSettings>>,
): void {
  writeProvidersFromPatchTo('chipsProvidersSecure', 'chipsLocalAiConfig', writeChipsLocalAiConfig, patch);
}

function writeProvidersFromPatchTo(
  secureKey: 'providersSecure' | 'chipsProvidersSecure',
  localCfgKey: 'providers' | 'chipsLocalAiConfig',
  writeLocalCfg: (cfg: ProviderSettings) => void,
  patch: Partial<Record<ProviderId, ProviderSettings>>,
): void {
  const existing = store.get(secureKey);
  const baseline: SecureProviderMap = existing
    ? { ...existing }
    : ({
        openrouter: { ciphertext: '', encrypted: false, enabled: false },
        anthropic: { ciphertext: '', encrypted: false, enabled: false },
        openai: { ciphertext: '', encrypted: false, enabled: false },
gemini: { ciphertext: '', encrypted: false, enabled: false },
          localai: { ciphertext: '', encrypted: false, enabled: false },
        } as SecureProviderMap);

  for (const id of Object.keys(patch) as ProviderId[]) {
    if (!PROVIDER_IDS.includes(id)) continue;
    const incoming = patch[id];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;

    const currentEntry =
      baseline[id] ?? { ciphertext: '', encrypted: false, enabled: false };
    let nextEnabled = currentEntry.enabled;
    if (typeof incoming.enabled === 'boolean') nextEnabled = incoming.enabled;

    if (typeof incoming.apiKey === 'string' && incoming.apiKey.length > 0) {
      // The user explicitly set a NEW key for this provider. Encrypt it
      // and overwrite the ciphertext. encryptKey handles the case where
      // safeStorage is unavailable (falls back to base64 + encrypted:false).
      const encrypted = encryptKey(incoming.apiKey);
      baseline[id] = { ...encrypted, enabled: nextEnabled };
    } else {
      // No new key in this patch → preserve existing ciphertext as-is,
      // only update the enabled flag. This is the critical anti-wipe
      // path: we NEVER decrypt-then-reencrypt during a generic save.
      baseline[id] = { ...currentEntry, enabled: nextEnabled };
    }
  }

  store.set(secureKey, baseline);

  // Local AI's non-secret config (base URL, model, detected list, toggles)
  // is stored in the plain config — not in the encrypted key store.
  // Persist it on every save so an enabled localai row survives a restart.
  const localAiIn = patch.localai;
  if (localAiIn && typeof localAiIn === 'object' && !Array.isArray(localAiIn)) {
    writeLocalCfg(localAiIn);
  }

  // opencode's non-secret config (local server base URL, agent, model) is
  // stored in the plain `providers` map too, exactly like localai — but ONLY
  // on the main-providers branch. The chips branch reuses this function with
  // the chips-only map, whose opencode entry is just {apiKey, enabled}; it
  // must NEVER overwrite the main slot (that exact cross-wire blanked the
  // user's model list + toggles on every full save).
  if (localCfgKey === 'providers') {
    const opencodeIn = patch.opencode;
    if (opencodeIn && typeof opencodeIn === 'object' && !Array.isArray(opencodeIn)) {
      writeOpencodeConfig(opencodeIn);
    }
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  // No more "decrypt all → merge → re-encrypt all" pattern. Each path
  // below writes only the affected provider entry, preserving the
  // ciphertexts of all others. See writeProvidersFromPatch's header
  // for the dev-mode safeStorage failure that motivated the change.
  if (patch.providers) {
    writeProvidersFromPatch(patch.providers);
  }
  if (patch.chipsProviders) {
    writeChipsProvidersFromPatch(patch.chipsProviders);
  }
  if (typeof patch.chipsUseMainProvider === 'boolean') {
    store.set('chipsUseMainProvider', patch.chipsUseMainProvider);
  }
  if (patch.chipsSource === 'smart' || patch.chipsSource === 'premade' || patch.chipsSource === 'custom') {
    store.set('chipsSource', patch.chipsSource);
  }
  if (Array.isArray(patch.customChips)) {
    store.set('customChips', patch.customChips.slice(0, 6));
  }
  if (typeof patch.openrouterApiKey === 'string' && patch.openrouterApiKey.length > 0) {
    // Legacy path: pre-v1.0.0 builds set the OpenRouter key via a
    // dedicated field. We honor it but never DECRYPT existing entries
    // — just encrypt the incoming key and overwrite the openrouter
    // ciphertext, preserving the other providers' bytes.
    const existing = store.get('providersSecure');
    const baseline: SecureProviderMap = existing
      ? { ...existing }
      : ({
          openrouter: { ciphertext: '', encrypted: false, enabled: true },
          anthropic: { ciphertext: '', encrypted: false, enabled: false },
          openai: { ciphertext: '', encrypted: false, enabled: false },
          gemini: { ciphertext: '', encrypted: false, enabled: false },
          localai: { ciphertext: '', encrypted: false, enabled: false },
        } as SecureProviderMap);
    const prevEnabled = baseline.openrouter?.enabled ?? true;
    const encrypted = encryptKey(patch.openrouterApiKey);
    baseline.openrouter = { ...encrypted, enabled: prevEnabled };
    store.set('providersSecure', baseline);
  }
  if (typeof patch.primaryModel === 'string' && patch.primaryModel.length > 0) {
    store.set('primaryModel', patch.primaryModel);
  }
  if (typeof patch.fallbackModel === 'string' && patch.fallbackModel.length > 0) {
    store.set('fallbackModel', patch.fallbackModel);
  }
  if (typeof patch.webSearch === 'boolean') store.set('webSearch', patch.webSearch);
  if (typeof patch.workspaceFolder === 'string' && patch.workspaceFolder.length > 0) {
    store.set('workspaceFolder', patch.workspaceFolder);
  }
  if (typeof patch.autoApproveTools === 'boolean') {
    store.set('autoApproveTools', patch.autoApproveTools);
  }
  if (typeof patch.dismissOnDoubleClick === 'boolean') {
    store.set('dismissOnDoubleClick', patch.dismissOnDoubleClick);
  }
  if (typeof patch.memorySaveEnabled === 'boolean') {
    store.set('memorySaveEnabled', patch.memorySaveEnabled);
  }
  if (typeof patch.contextMemoryEnabled === 'boolean') {
    store.set('contextMemoryEnabled', patch.contextMemoryEnabled);
  }
  if (typeof patch.maxContextTokens === 'number' && Number.isFinite(patch.maxContextTokens)) {
    store.set('maxContextTokens', Math.max(2000, Math.min(512000, Math.round(patch.maxContextTokens))));
  }
  if (typeof patch.autoContext === 'boolean') {
    store.set('autoContext', patch.autoContext);
  }
  if (typeof patch.annotFinalPass === 'boolean') {
    store.set('annotFinalPass', patch.annotFinalPass);
  }
  if (typeof patch.voiceLanguage === 'string' && patch.voiceLanguage.length > 0) {
    store.set('voiceLanguage', patch.voiceLanguage);
  }
  if (patch.sttEngine === 'auto' || patch.sttEngine === 'local' || patch.sttEngine === 'cloud') {
    store.set('sttEngine', patch.sttEngine);
  }
  if (typeof patch.sttModel === 'string') {
    store.set('sttModel', patch.sttModel.slice(0, 32));
  }
  if (typeof patch.sttInitialPrompt === 'string') {
    store.set('sttInitialPrompt', patch.sttInitialPrompt.slice(0, 300));
  }
  if (typeof patch.sttWordOverrides === 'string') {
    store.set('sttWordOverrides', patch.sttWordOverrides.slice(0, 4000));
  }
  const VALID_HOTKEYS: TriggerHotkey[] = [
    'MetaRight', 'CtrlRight', 'AltRight', 'ShiftRight',
    'MetaLeft', 'CtrlLeft', 'AltLeft', 'ShiftLeft',
    'MetaEither', 'CtrlEither',
  ];
  if (patch.triggerHotkey && VALID_HOTKEYS.includes(patch.triggerHotkey)) {
    store.set('triggerHotkey', patch.triggerHotkey);
  }
  if (patch.userProfile && typeof patch.userProfile === 'object') {
    const cur = store.get('userProfile') ?? DEFAULT_USER_PROFILE;
    store.set('userProfile', { ...DEFAULT_USER_PROFILE, ...cur, ...patch.userProfile });
  }
  if (typeof patch.personalizePrompts === 'boolean') {
    store.set('personalizePrompts', patch.personalizePrompts);
  }
  if (typeof patch.audioMode === 'boolean') {
    store.set('audioMode', patch.audioMode);
  }
  if (
    patch.themePreference === 'system' ||
    patch.themePreference === 'light' ||
    patch.themePreference === 'dark'
  ) {
    store.set('themePreference', patch.themePreference);
  }
  if (typeof patch.mouseWiggleEnabled === 'boolean') {
    store.set('mouseWiggleEnabled', patch.mouseWiggleEnabled);
  }
  if (patch.wiggleSensitivity === 'low' || patch.wiggleSensitivity === 'normal' || patch.wiggleSensitivity === 'high') {
    store.set('wiggleSensitivity', patch.wiggleSensitivity);
  }
  if (patch.chipVisibility === 'both' || patch.chipVisibility === 'voice' || patch.chipVisibility === 'type' || patch.chipVisibility === 'off') {
    store.set('chipVisibility', patch.chipVisibility);
  }
  if (typeof patch.reducedTransparency === 'boolean') {
    store.set('reducedTransparency', patch.reducedTransparency);
  }
  // Glass look — clamped Hermes-style ranges, instant-apply (the SettingsSet
  // IPC handler repaints overlays right after this returns).
  if (patch.glassMode === 'clear' || patch.glassMode === 'glass') {
    store.set('glassMode', patch.glassMode);
  }
  if (typeof patch.glassIntensity === 'number' && Number.isFinite(patch.glassIntensity)) {
    store.set('glassIntensity', Math.max(0, Math.min(100, Math.round(patch.glassIntensity))));
  }
  if (typeof patch.glassFade === 'number' && Number.isFinite(patch.glassFade)) {
    store.set('glassFade', Math.max(0, Math.min(100, Math.round(patch.glassFade))));
  }
  if (
    patch.glassMaterial === 'under-window' ||
    patch.glassMaterial === 'popover' ||
    patch.glassMaterial === 'titlebar' ||
    patch.glassMaterial === 'header'
  ) {
    store.set('glassMaterial', patch.glassMaterial);
  }
  if (patch.glassScope === 'window' || patch.glassScope === 'sidebar') {
    store.set('glassScope', patch.glassScope);
  }
  if (typeof patch.screenshotCropW === 'number' && Number.isFinite(patch.screenshotCropW)) {
    store.set('screenshotCropW', Math.max(128, Math.min(2048, Math.round(patch.screenshotCropW))));
  }
  if (typeof patch.screenshotCropH === 'number' && Number.isFinite(patch.screenshotCropH)) {
    store.set('screenshotCropH', Math.max(128, Math.min(2048, Math.round(patch.screenshotCropH))));
  }
  if (typeof patch.annotOffsetX === 'number' && Number.isFinite(patch.annotOffsetX)) {
    store.set('annotOffsetX', Math.max(-2048, Math.min(2048, Math.round(patch.annotOffsetX || 0))));
  }
  if (typeof patch.annotOffsetY === 'number' && Number.isFinite(patch.annotOffsetY)) {
    store.set('annotOffsetY', Math.max(-2048, Math.min(2048, Math.round(patch.annotOffsetY || 0))));
  }
  if (patch.calendarProvider === 'google' || patch.calendarProvider === 'outlook') {
    store.set('calendarProvider', patch.calendarProvider);
  }
  if (typeof patch.notificationsEnabled === 'boolean') {
    store.set('notificationsEnabled', patch.notificationsEnabled);
  }
  if (typeof patch.clearMemoryOnQuit === 'boolean') {
    store.set('clearMemoryOnQuit', patch.clearMemoryOnQuit);
  }
  if (typeof patch.ghostMode === 'boolean') {
    store.set('ghostMode', patch.ghostMode);
  }
  if (typeof patch.ghostHideTaskbar === 'boolean') {
    store.set('ghostHideTaskbar', patch.ghostHideTaskbar);
  }
  if (patch.customShortcuts && typeof patch.customShortcuts === 'object') {
    store.set('customShortcuts', patch.customShortcuts);
  }
  // The store change subscription already invalidates, but do it explicitly
  // here so the value this function returns can never be the pre-write memo.
  invalidateSettingsCache();
  return getSettings();
}

// Skills (Phase 5). null = the user has never configured skills → bundled
// skills fall back to their frontmatter defaultEnabled. A non-null array is
// authoritative (an empty array means all skills disabled on purpose).
// Self-learned profile (Hermes USER.md-style): fills Settings profile fields
// the user left EMPTY from facts the agent extracted itself ("User's name is
// X"). Never overwrites anything the user typed. Returns the filled field
// names (empty = nothing learned). The learned values surface in Settings UI
// and ride the prompt via buildUserProfileLine like hand-entered ones.
export function applyLearnedProfile(update: {
  name?: string;
  role?: string;
  preferredLanguage?: string;
}): string[] {
  const cur = store.get('userProfile') ?? DEFAULT_USER_PROFILE;
  const next = { ...DEFAULT_USER_PROFILE, ...cur };
  const filled: string[] = [];
  const take = (
    key: 'name' | 'role' | 'preferredLanguage',
    label: string,
    value: string | undefined,
  ): void => {
    const v = (value ?? '').trim().slice(0, 80);
    if (v && !(next[key] ?? '').trim()) {
      next[key] = v;
      filled.push(label);
    }
  };
  take('name', 'name', update.name);
  take('role', 'role', update.role);
  take('preferredLanguage', 'language', update.preferredLanguage);
  if (filled.length > 0) {
    store.set('userProfile', next);
    console.log('[settings] learned profile from conversation:', filled.join(','));
  }
  return filled;
}

export function getEnabledSkillIds(): string[] | null {
  const v = store.get('enabledSkills');
  if (v === null || v === undefined || !Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}

export function setEnabledSkills(ids: string[]): void {
  store.set('enabledSkills', Array.from(new Set(ids)));
}

export function getWorkspaceFolder(): string {
  return store.get('workspaceFolder');
}

export function hasApiKey(): boolean {
  const providers = decryptProviders(store.get('providersSecure'));
  return Object.values(providers).some((p) => p.apiKey.length > 0);
}

// Exposed for tests / diagnostics. Returns the hardcoded string the legacy
// recovery path uses; new writes never touch it.
export function legacyEnvelopeKey(): string {
  return LEGACY_ENVELOPE_KEY;
}
