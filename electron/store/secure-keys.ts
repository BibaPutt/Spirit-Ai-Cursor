import { safeStorage } from 'electron';
import type { ProviderId, ProviderSettings } from '../types';
import { PROVIDER_IDS } from './defaults';

// Re-export: PROVIDER_IDS moved to ./defaults.ts (Electron-free) so the Bun
// sidecar can iterate the same list without importing this module (which
// pulls in electron). Existing `from './secure-keys'` imports keep working.
export { PROVIDER_IDS } from './defaults';

// Storage for API keys backed by the OS keyring where available:
//   - macOS: Keychain (via safeStorage)
//   - Windows: DPAPI (via safeStorage)
//   - Linux: libsecret / kwallet (via safeStorage when present)
//
// Plaintext fallback is intentionally NOT supported. If safeStorage cannot
// encrypt (`isEncryptionAvailable()` returns false), keys are still stored
// in electron-store but marked as such so the renderer can warn the user.
//
// On macOS the Keychain path means a user with FileVault on cannot have
// their keys lifted by reading config.json directly — that file no longer
// contains the keys at all once this module owns them.

export type EncryptedKey = {
  // Base64 encoding of the encrypted ciphertext returned by safeStorage.
  // Empty string means "no key set".
  ciphertext: string;
  // Indicates whether the value was encrypted (true) or stored as plaintext
  // because the platform refused encryption (false). Renderer can surface
  // a warning in the latter case.
  encrypted: boolean;
};

export type SecureProviderMap = Record<ProviderId, EncryptedKey & { enabled: boolean }>;

const EMPTY: EncryptedKey = { ciphertext: '', encrypted: false };

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptKey(plaintext: string): EncryptedKey {
  if (!plaintext) return EMPTY;
  if (!isEncryptionAvailable()) {
    logFailure('encrypt', undefined, 'keychain-unavailable', null);
    // Falls back to base64 of the raw bytes. NOT encryption, just storage.
    // The `encrypted: false` flag is what matters; callers can warn the user.
    return { ciphertext: Buffer.from(plaintext, 'utf-8').toString('base64'), encrypted: false };
  }
  try {
    const buf = safeStorage.encryptString(plaintext);
    return { ciphertext: buf.toString('base64'), encrypted: true };
  } catch (err) {
    logFailure('encrypt', undefined, 'keychain-denied', err);
    return { ciphertext: Buffer.from(plaintext, 'utf-8').toString('base64'), encrypted: false };
  }
}

// Last-failure reason from decryptKey. Set when a non-empty stored key
// cannot be decrypted (keychain denied, encryption unavailable, etc).
// The query-path (router.ts) reads this to produce an actionable error
// message instead of "No provider configured" — which previously left
// the user with no clue that the real problem was keychain access.
// Cleared on every successful decrypt so a stale reason can't leak.
//
// On Windows DPAPI in particular, encryption can succeed when the key
// is first saved but a later decrypt — same machine,
// same user — can fail with a generic CryptUnprotectData error if the
// DPAPI master key state is in an unexpected mode (NSIS installer
// context, OneDrive-roamed profile, password change since encrypt).
// The structured log helps diagnose which case fired.
export type DecryptFailure =
  | 'none'
  | 'keychain-unavailable'
  | 'keychain-denied'
  | 'corrupt-ciphertext';
let lastDecryptFailure: DecryptFailure = 'none';
const perProviderFailure: Record<string, DecryptFailure> = {};
export function getLastDecryptFailure(): DecryptFailure {
  return lastDecryptFailure;
}
export function resetDecryptFailure(): void {
  lastDecryptFailure = 'none';
}
// Read-only view of per-provider failure reasons. Populated by
// `probeProviderHealth` during startup and by ad-hoc decrypt failures
// at query time. Renderer reads this via the providers:health IPC to
// surface a banner on broken-decrypt states.
export function getProviderFailures(): Readonly<Record<string, DecryptFailure>> {
  return perProviderFailure;
}
export function clearProviderFailure(provider: string): void {
  delete perProviderFailure[provider];
  // Allow the next failure for this provider to be re-logged once.
  for (const sig of Array.from(loggedSignatures)) {
    if (sig.includes(`:${provider}:`)) loggedSignatures.delete(sig);
  }
}

// Per-session dedupe so a single failure mode doesn't spam the log on
// every getSettings() / decryptProviders() call (which can fire dozens
// of times per query through the personalize + profile + chain paths).
// Each (stage, provider, reason) tuple is logged ONCE per session.
// A successful decrypt for the same provider clears its entries so a
// recovered state is visible on next failure.
const loggedSignatures = new Set<string>();

// Decrypted-value cache. `safeStorage.decryptString` is an OS keychain call
// (DPAPI on Windows) costing hundreds of microseconds, and getSettings() sits
// on the input hot path — it used to re-decrypt every provider key on every
// mouse move. The ciphertext is the cache key: any key change produces
// different ciphertext, so a stale entry can never be served. Failures are
// never cached, so a later keychain recovery still works.
const DECRYPT_CACHE_MAX = 64;
const decryptCache = new Map<string, string>();

function decryptCacheKey(stored: EncryptedKey): string {
  return `${stored.encrypted ? 'e' : 'b'}:${stored.ciphertext}`;
}

function logFailure(stage: 'decrypt' | 'encrypt', provider: string | undefined, reason: DecryptFailure, err: unknown): void {
  const sig = `${stage}:${provider ?? 'unknown'}:${reason}`;
  if (loggedSignatures.has(sig)) return;
  loggedSignatures.add(sig);
  console.warn(
    `[secure-keys] ${stage} failure: ${JSON.stringify({
      stage,
      provider: provider ?? 'unknown',
      reason,
      encryptionAvailable: isEncryptionAvailable(),
      platform: process.platform,
      message: err instanceof Error ? err.message : String(err ?? ''),
      note: 'further identical failures suppressed until a successful decrypt for this provider',
    })}`,
  );
}

// Internal: decrypt with awareness of WHICH provider is being decrypted,
// so per-provider failure state can be tracked accurately. The public
// `decryptKey` keeps its existing single-argument signature for callers
// that don't know the provider id (e.g. tests).
function decryptKeyTracked(
  stored: EncryptedKey | undefined | null,
  provider?: string,
): string {
  if (!stored || !stored.ciphertext) {
    if (provider) clearProviderFailure(provider);
    return '';
  }
  const cacheKey = decryptCacheKey(stored);
  const cached = decryptCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (!stored.encrypted) {
    // Legacy / fallback path: base64-only.
    try {
      const text = Buffer.from(stored.ciphertext, 'base64').toString('utf-8');
      lastDecryptFailure = 'none';
      if (provider) clearProviderFailure(provider);
      if (decryptCache.size >= DECRYPT_CACHE_MAX) decryptCache.clear();
      decryptCache.set(cacheKey, text);
      return text;
    } catch (err) {
      lastDecryptFailure = 'corrupt-ciphertext';
      if (provider) perProviderFailure[provider] = 'corrupt-ciphertext';
      logFailure('decrypt', provider, 'corrupt-ciphertext', err);
      return '';
    }
  }
  if (!isEncryptionAvailable()) {
    lastDecryptFailure = 'keychain-unavailable';
    if (provider) perProviderFailure[provider] = 'keychain-unavailable';
    logFailure('decrypt', provider, 'keychain-unavailable', null);
    return '';
  }
  try {
    const buf = Buffer.from(stored.ciphertext, 'base64');
    const text = safeStorage.decryptString(buf);
    lastDecryptFailure = 'none';
    if (provider) clearProviderFailure(provider);
    if (decryptCache.size >= DECRYPT_CACHE_MAX) decryptCache.clear();
    decryptCache.set(cacheKey, text);
    return text;
  } catch (err) {
    // On macOS this typically means the user denied or revoked keychain
    // access. On Windows it's a DPAPI master-key mismatch. Linux can
    // fail with the same path if libsecret refuses.
    lastDecryptFailure = 'keychain-denied';
    if (provider) perProviderFailure[provider] = 'keychain-denied';
    logFailure('decrypt', provider, 'keychain-denied', err);
    return '';
  }
}

export function decryptKey(stored: EncryptedKey | undefined | null): string {
  return decryptKeyTracked(stored, undefined);
}

// Provider-aware decrypt: on success clears the per-provider failure entry so
// a stale startup-probe failure can't linger after a later decrypt works.
export function decryptProviderKey(
  stored: EncryptedKey | undefined | null,
  provider: string,
): string {
  return decryptKeyTracked(stored, provider);
}

// Convert plain provider settings (with plaintext apiKey strings) into the
// encrypted-on-disk shape. Used when settings are written from the renderer.
export function encryptProviders(
  plain: Record<ProviderId, ProviderSettings>,
): SecureProviderMap {
  const out = {} as SecureProviderMap;
  for (const id of Object.keys(plain) as ProviderId[]) {
    const p = plain[id];
    const encrypted = encryptKey(p.apiKey ?? '');
    out[id] = { ...encrypted, enabled: !!p.enabled };
  }
  return out;
}

// Reverse: read encrypted-on-disk and produce plaintext provider settings
// for in-process use. Note: the plaintext value lives only in main-process
// memory and is sent through IPC for the settings form (the user explicitly
// asked to see it). It is never written back to disk in plaintext.
export function decryptProviders(
  enc: SecureProviderMap | null | undefined,
): Record<ProviderId, ProviderSettings> {
  const out = {} as Record<ProviderId, ProviderSettings>;
  for (const id of PROVIDER_IDS) {
    const e = enc?.[id];
    out[id] = { apiKey: decryptKeyTracked(e, id), enabled: !!e?.enabled };
  }
  return out;
}

// One-shot startup probe: for every provider that HAS a ciphertext on
// disk and is marked encrypted=true, try to decrypt once and record
// the result in `perProviderFailure`. The renderer reads this map via
// IPC and shows a banner if any provider is broken.
//
// Caller (settings.ts) is responsible for invoking this after the
// store is initialised. Safe to call repeatedly — each call is one
// keychain attempt per encrypted provider, which is also what would
// happen on the first query anyway.
export function probeProviderHealth(enc: SecureProviderMap | null | undefined): void {
  if (!enc) return;
  // A probe without an available keychain is meaningless: every encrypted key
  // would be flagged broken. The real decrypt path re-checks availability at
  // query time, so skip the probe entirely here instead of producing a
  // false alarm (Windows reports encryption unavailable until app 'ready').
  if (!isEncryptionAvailable()) return;
  for (const id of PROVIDER_IDS) {
    const entry = enc[id];
    if (!entry || !entry.ciphertext || !entry.encrypted) continue;
    decryptKeyTracked(entry, id);
  }
}
