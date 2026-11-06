# agent.md — Spirit Project Operations Manual

This file is the entry point for any developer or AI agent working on
**Spirit** (the `spirit` app). Read this first, then open the specific
docs listed in [README.md](README.md).

## What Spirit is

Spirit is an **AI-aware cursor companion**: a small always-on-top overlay that
appears next to your cursor when you hold the trigger key (Right-Cmd), shows a
prompt pill, captures a screenshot of what's under the cursor, and lets you ask
an LLM questions about it. It can read your screen (OCR), clipboard, text
selection, and foreground app; it can act on the computer through a tool
registry (clicking, typing, launching apps, saving documents, searching the
web, etc.). It also remembers things across sessions using a mem0-style
context memory built in-house.

- **Runtime:** Electron (main + renderer), React 18, TypeScript
- **Build:** Vite + `tsc` (two tsconfigs)
- **Tests:** Vitest (`npm test`)

## Project layout

```
spirit/
├── electron/       main process (all native work: capture, LLM, tools, memory, IPC)
│   ├── main.ts     app bootstrap & lifecycle
│   ├── preload.ts  contextBridge → window.spirit (SpiritAPI)
│   ├── types.ts    shared types between main & renderer
│   ├── apps/       macOS app launcher (via AppleScript/PowerShell)
│   ├── capture/    screenshots, OCR, scene, clipboard, selection, app-context
│   ├── input/      global keyboard/mouse hook, trigger detection, cursor tracking
│   ├── ipc/        channel names + all IPC handlers
│   ├── llm/        prompt building, models, templates, chips, providers, tools
│   ├── memory/     context memory (BM25) + session persistence
│   ├── save/       document save/template rendering
│   ├── store/      settings + secure API-key storage
│   ├── system/     system audio helpers
│   ├── tray/       menu bar / tray icon
│   ├── voice/      TTS + STT (cloud & local whisper sidecar)
│   └── windows/    overlay windows, about window, macOS traffic lights
├── renderer/       overlay UI (React)
│   ├── App.tsx     main overlay component
│   ├── components/ UI pieces (pill, chips, settings, markdown, cursors…)
│   ├── hooks/      React hooks bridging IPC events
│   ├── lib/        renderer utilities (ipc proxy, positioning, commands…)
│   └── styles/     globals.css (theme, accent, tailwind)
├── tests/          Vitest suites
├── scripts/        build/install helpers
└── assets/ cursors/ branding & custom cursor art
```

## Essential commands

Run from the `spirit/` directory:

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies (runs postinstall: installs native deps + STT script) |
| `npm run dev` | Start Vite dev server (renderer hot reload) |
| `npm run build` | Production build (Vite + `tsc -p tsconfig.node.json`) |
| `npm run typecheck` | Type-check both tsconfigs |
| `npm test` | Run all Vitest suites |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Package installers via electron-builder |

## Debugging wrong runtime behaviour

When the app misbehaves (overlay not showing/hiding, AI answer cancelled,
wrong provider used for chips, chips empty, etc.) check the **latest dev
session log first** instead of guessing:

1. Run `npm run dev` and reproduce the problem.
2. Open the newest `logs/session-*.log` in the `spirit/` folder (the exact
   path is printed to the terminal at startup: `[main] dev session log: ...`).
3. Grep it for the relevant tags:
   - `[main] AI mode started / ended, reason=…` — why the box opened/closed.
   - `[chips]` + `[chips/ai]` — chip generation input, chain, model, raw
     output, and overlay dismiss/cancel requests.
   - `[agentic]` — the AI's inner steps and every tool it executed.
   - `[overlay]` — overlay hide/restore around captures.

Dev-only logging is implemented in `electron/dev/session-log.ts`: only runs
unpackaged (`app.isPackaged === false`), auto-creates `logs/`, writes one file
per app run, prunes "small" sessions (< 20 meaningful lines, e.g. quick build
restarts) and rotates to at most 10 session files (oldest deleted).

## Conventions

- **TypeScript strict** — new code must type-check under `npm run typecheck`.
- **Main process only talks to the renderer through `SpiritAPI`** (see
  `electron/preload.ts` + `electron/types.ts`). Renderer never requires
  Electron directly; it uses the `ipc` proxy in `renderer/lib/ipc.ts`.
- **Channel names** are centralized in `electron/ipc/channels.ts`. Always add
  a channel there and mirror it in `preload.ts` + `types.ts` + handlers.
- **No comments unless asked.** Existing code has rich comments — match that
  style only when the task requires explanation (project convention is
  explanatory comments on tricky logic, but do not add noise).
- **Errors cross IPC as `{ ok: true } | { ok: false; error: string }`**
  where reasonable (see `insertText`, `captureSelection`, `saveResponse`).
- **Native/non-portable code is platform-guarded** (`process.platform ===
  'darwin'` etc.) and degrades gracefully (see `secure-keys.ts`, `voice/`).
- **Files are organized by responsibility**, not by type. When adding a new
  capability, put it in the matching `electron/<area>/` folder and export via
  an `index.ts`/registry pattern like `llm/tools/index.ts`.

## Where the interesting bits live

| Question | Look here |
| --- | --- |
| How is an AI query served? | `electron/ipc/handlers.ts` → `runQuery` |
| How are providers picked? | `electron/llm/providers/router.ts` (`runPlainCompletion`) |
| How do tools run & get approved? | `electron/llm/tools/index.ts`, `electron/ipc/handlers.ts`, `approval.ts` |
| How is the screenshot taken? | `electron/capture/screenshot.ts` |
| How does the overlay track the cursor? | `electron/input/*`, `renderer/lib/positioning.ts` |
| How does context memory work? | `electron/memory/contextMemory.ts` (BM25 + remember pipeline) |
| Where are sessions saved? | `electron/memory/sessions.ts` |
| Where are API keys stored? | `electron/store/secure-keys.ts` (safeStorage) |
| Where are settings stored? | `electron/store/settings.ts` (`config.json` in userData) |
| What does the trigger key do? | `electron/input/trigger.ts`, `renderer/App.tsx` |
| How does the box know where to render? | `renderer/hooks/useCursorPosition.ts`, `electron/input/cursor.ts` |
| Why is the app misbehaving at runtime? | newest `logs/session-*.log` (dev-only; see "Debugging" above) |

## Do / Don't

- **Do** run `npm run typecheck` and `npm test` before considering a change done.
- **Do** check the latest `logs/session-*.log` when debugging wrong runtime
  behaviour (dev-only log, newest file = last run).
- **Do** add tests in `tests/` for new pure logic (BM25, split, chips, voice
  commands, etc.). The repo has a strong Vitest suite — keep it green.
- **Don't** commit secrets. Keys live in `secure-keys.ts`, never in the repo.
- **Don't** break the IPC contract — changing `SpiritAPI` requires updating
  `preload.ts`, `types.ts`, and every renderer consumer.
- **Don't** block the trigger-to-box path on slow work. The startup sequence
  (screenshot, chips, app-context) is intentionally fire-and-forget/lazy — see
  `02-main-process.md` for the "first trigger" pitfalls to avoid.

## Getting oriented fast

1. Read [01-architecture.md](01-architecture.md) — how the whole system fits.
2. Trace one end-to-end flow: hold trigger → `input/trigger.ts` →
   `broadcastAIModeStart` → renderer shows the pill →
   `submit` → `llm:query-options` → `handlers.ts` `runQuery` →
   `providers/router.ts` → stream back → `llm:chunk`/`llm:final` → pill shows
   the answer.
3. Then read the area docs for whatever you're touching.
