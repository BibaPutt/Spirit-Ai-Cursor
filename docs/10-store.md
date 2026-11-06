# 10 — Store (`electron/store/*`)

Persistence for settings and API keys.

## `settings.ts`

The app's configuration store. Backed by a plain JSON file (`config.json`) in
the Electron `userData` directory — **no `electron-store` dependency**, a
small hand-rolled loader.

- `getSettings()` / `getSettingsLight()` — full / lightweight snapshot of
  `Settings` (the shape lives in `electron/types.ts`). Light is used for
  high-frequency callers.
- `setSettings(patch)` — merge a partial patch, persist atomically, broadcast
  settings-change so the renderer re-renders.
- `getWorkspaceFolder()` — the user-picked folder for sessions + memory
  (falls back to a default under the user home).
- `getLocalAiConfig()` / `hasLocalAiServer()` — LocalAI endpoint info.
- `getProvidersHealth()` — aggregated provider health (enabled + has key +
  decrypt status) for the renderer banner.
- `getDecryptedProviderKey(id)` / `hasProviderKey(id)` — key access.
- `hasApiKey()` — any usable key at all (used by the "open settings on first
  run" auto-show).
- `legacyEnvelopeKey()` — migration helper for older config encryption.

### Recovery
The settings loader is resilient: a legacy-encrypted `config.json` that can't
be decrypted with the current envelope key is detected and recovered rather
than crashing (see `main.ts`'s fatal-init dialog for the last-resort path).

## `secure-keys.ts`

API-key storage backed by the OS keyring via Electron `safeStorage`
(macOS Keychain / Windows DPAPI / Linux libsecret).

- `EncryptedKey = { ciphertext: string; encrypted: boolean }` — base64 of the
  encrypted blob; `encrypted:false` marks a fallback (base64-only) when the
  keyring is unavailable.
- `SecureProviderMap` — `Record<ProviderId, EncryptedKey & { enabled }>`.
- `PROVIDER_IDS` — single source of truth: `openrouter, anthropic, openai,
  gemini, localai, opencode`.
- `encryptKey` / `decryptKey` — raw encrypt/decrypt. Plaintext fallback is
  intentionally **not** supported (keys are only ever stored encrypted or
  flagged plaintext for a warning).
- `encryptProviders(plain)` / `decryptProviders(enc)` — convert between the
  renderer's plaintext settings shape and the encrypted-on-disk shape.
- `probeProviderHealth(enc)` — one-shot startup probe: tries to decrypt every
  stored encrypted key and records per-provider results.

### Decrypt failure diagnostics
- `DecryptFailure` = `none | keychain-unavailable | keychain-denied | corrupt-ciphertext`.
- `getLastDecryptFailure()` / `resetDecryptFailure()` — global last reason.
- `getProviderFailures()` / `clearProviderFailure()` — per-provider map read
  by the renderer banner.
- `logFailure` — per-session deduped structured logging (a repeated failure is
  logged once per `(stage, provider, reason)` tuple until a successful decrypt
  clears it).

> Known Windows gotcha documented in code: DPAPI can succeed at encrypt time
> and later fail at decrypt time (NSIS installer context, OneDrive-roamed
> profile, password change). The structured log exists to diagnose exactly
> which case fired.

## Disk layout (`userData`)
```
userData/
├── config.json        # settings + { providers: SecureProviderMap }
└── (icon cache, etc.)
```
Keys never appear in plaintext on disk; on macOS with FileVault the keychain
backing means reading `config.json` alone cannot lift keys. Workspace data
(sessions, memory) lives under the workspace folder, not `userData`.
