# 16 — Build, Tooling, Packaging

## Project metadata
- `package.json` — `name: spirit-deep`, `version: 2.0.0-alpha.0`, `private`,
  CJS (`"main": "dist-electron/main.js"`). Description: "Spirit Deep —
  AI-aware cursor companion (Electron)". License: `BUSL-1.1` (see
  `LICENSE` for the few MIT-licensed portions).

## Key dependencies
- **Runtime**: Electron 30, uiohook-napi (global hook), electron-store,
  msedge-tts, marked, react-markdown + remark/rehype (markdown rendering),
  @tabler/icons-react, franc-min (language detection).
- **Dev**: Vite 5, vite-plugin-electron, TypeScript 5, electron-builder 24,
  React 18, tailwindcss, framer-motion, Vitest 4, sharp (icon/image work).

## npm scripts (run from `spirit/`)
| Script | What it does |
| --- | --- |
| `npm run dev` | `vite` — renderer dev server (hot reload) |
| `npm run build` | `vite build && tsc -p tsconfig.node.json` — renderer bundle + main-process compile |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit` |
| `npm test` | `vitest run` |
| `npm run test:watch` | `vitest` (watch mode) |
| `npm run dist` | build + `electron-builder --mac --win --linux` |
| `npm run dist:mac` | build + `electron-builder --mac --arm64 --x64` |
| `npm run dist:mac:unsigned` | mac build with `CSC_IDENTITY_AUTO_DISCOVERY=false` |
| `npm run dist:win` / `dist:linux` / `dist:all` | platform installers |
| `postinstall` | `electron-builder install-app-deps && node scripts/install-stt.js` (build native deps + set up the local STT sidecar) |

## Two tsconfigs
- `tsconfig.json` — renderer (Vite/React) type-check target.
- `tsconfig.node.json` — main process (Node/Electron) compile target.
  `build` compiles main with `tsc`; the renderer is bundled by Vite.

## Build outputs
- `dist-electron/` — compiled main process (`main.js`) + preload.
- `dist/` — packaged installers / apps per platform (electron-builder).
- Renderer bundle is emitted by Vite (e.g. `main-CRasAMHZ.js`, ~757 kB).

## Startup / packaging facts
- `main` entry: `dist-electron/main.js`; preload bundled alongside.
- `postinstall` installs native module builds for the current platform
  (`uiohook-napi` needs rebuilt node-gyp artifacts) and provisions the
  faster-whisper STT sidecar via `scripts/install-stt.js`.
- License is `BUSL-1.1` — no telemetry, no analytics, no cloud.

## Legal documents & the in-app Legal window
- Canonical legal docs live at the repo root: `TERMS.md`, `PRIVACY.md`,
  `CREDITS.md` (plus `LICENSE`, `THIRD-PARTY-NOTICES.md`, `cursors/LICENSE`).
- `electron/windows/legal.ts` renders them in a tabbed Legal window
  (Terms / Privacy / Credits / License). It reads the files at runtime from
  `app.getAppPath()` — repo root in dev, asar root when packaged — so the
  electron-builder `files` list **must** keep `TERMS.md`, `PRIVACY.md`,
  `CREDITS.md`, `LICENSE`. Removing them breaks the window (it falls back to
  a "not found" notice rather than crashing).
- Entry points: tray menu (About Spirit / Terms / Privacy / Credits &
  License) and the About window footer links, which use the
  `spirit-legal://terms|privacy|credits|license` pseudo-scheme intercepted
  in the About window's `setWindowOpenHandler` (the data: page has no IPC).
- `build/entitlements.mac.plist` is required by the mac target — do not
  delete the `build/` directory.

## Windows signing & releases (SideQuestai pattern, done safely)
- Signing is **env-gated only**: set `CSC_LINK` (path or base64 of a .pfx)
  and `CSC_KEY_PASSWORD` in the shell/CI, then `npm run dist:win`. Without
  them the NSIS build succeeds unsigned — right behaviour for local dev.
- **Never commit `cert.pfx`, a plaintext certificate password, or any
  creds json** — the SideQuestai repo carries exactly that debt and its own
  audit (`docs/audits/02-secrets-dependencies.md`, finding S2) calls it
  CRITICAL: anyone who can read the repo can sign binaries as them. CI
  should inject `CSC_LINK`/`CSC_KEY_PASSWORD` from secrets at build time.
- macOS signing/notarization is also env-gated: `CSC_IDENTITY`,
  `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (see the
  electron-builder.yml header comment). Missing vars → signed-but-
  unnotarized or unsigned; unsigned is the fast local-iteration default.
- Releases: `publish` config points at GitHub `BibaPutt/Spirit-AI-Cursor`.
  `electron-builder --publish always` (from a tagged build, with
  `GH_TOKEN`) uploads the installers + `latest.yml`; without `--publish`
  the artifacts land in `release/` locally.

## Verification before shipping
1. `npm run typecheck` — clean.
2. `npm test` — 140/140 passing.
3. `npm run build` — produces `dist-electron/main.js` + renderer bundle.
4. `npm run dist:<platform>` — installers.

See [02-main-process.md](02-main-process.md) for runtime startup and
[15-testing.md](15-testing.md) for the test suite detail.
