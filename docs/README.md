# Spirit — Documentation

This directory documents the **spirit** project ("Spirit"), an AI-aware
cursor companion built with Electron, React, and TypeScript. The documentation
is organized **folder-wise**, mirroring the source layout, so every part of the
codebase has a home here.

> **New here?** Start with `../AI_CONTEXT.md` — the single-source-of-truth for
> the entire codebase. Then use the docs below for subsystem deep-dives.

## How to read this documentation

| File | Covers |
| --- | --- |
| [agent.md](agent.md) | Operations manual for AI agents/developers: build, test, conventions, do's & don'ts |
| [01-architecture.md](01-architecture.md) | System overview, runtime flow, data flow, tech stack |
| [02-main-process.md](02-main-process.md) | `electron/main.ts` lifecycle, startup sequence, global hook, overlays |
| [03-ipc.md](03-ipc.md) | Preload bridge (`SpiritAPI`), IPC channels, `ipc/handlers.ts`, shared types |
| [04-capture.md](04-capture.md) | `electron/capture/*` — screenshots, OCR, scene, selection, clipboard, app-context, active-tab, foreground-watcher, spirit-windows, PS worker |
| [05-input.md](05-input.md) | `electron/input/*` — global hook, trigger detection, cursor tracking, focus, click/scroll forwarding |
| [06-llm.md](06-llm.md) | `electron/llm/*` — prompt, models, templates, split, chips, link-meta, openrouter helpers |
| [07-providers.md](07-providers.md) | `electron/llm/providers/*` — registry, router, provider clients, health probing, key testing |
| [08-tools.md](08-tools.md) | `electron/llm/tools/*` — the tool registry and every tool executor |
| [09-memory.md](09-memory.md) | `electron/memory/*` — context memory (BM25, mem0-style), session persistence |
| [10-store.md](10-store.md) | `electron/store/*` — settings store (`config.json`), secure key storage (safeStorage) |
| [11-save.md](11-save.md) | `electron/save/*` — Markdown/HTML document rendering and saving |
| [12-voice.md](12-voice.md) | `electron/voice/*` — TTS (msedge-tts), cloud + local STT (faster-whisper sidecar) |
| [13-windows-tray-apps.md](13-windows-tray-apps.md) | `electron/windows/*`, `tray/*`, `apps/*`, `system/*`, `permissions.ts`, `autostart.ts`, `lifecycle.ts` |
| [14-renderer.md](14-renderer.md) | `renderer/*` — App, components, hooks, lib utilities, styles |
| [15-testing.md](15-testing.md) | `tests/*` — test files, what each covers, how to run |
| [16-build.md](16-build.md) | Tooling, npm scripts, packaging, dist artifacts |

## Folder map (source ↔ docs)

```
spirit/
├── assets/            → branding assets (icons, etc.)
├── cursors/           → custom cursor bitmaps
├── electron/
│   ├── main.ts        → 02-main-process.md
│   ├── preload.ts     → 03-ipc.md
│   ├── types.ts       → 03-ipc.md
│   ├── lifecycle.ts   → 13-windows-tray-apps.md
│   ├── permissions.ts → 13-windows-tray-apps.md
│   ├── autostart.ts   → 13-windows-tray-apps.md
│   ├── apps/          → 13-windows-tray-apps.md (launcher)
│   ├── capture/       → 04-capture.md
│   ├── input/         → 05-input.md
│   ├── ipc/           → 03-ipc.md
│   ├── llm/
│   │   ├── providers/ → 07-providers.md
│   │   ├── tools/     → 08-tools.md
│   │   └── (core)     → 06-llm.md
│   ├── memory/        → 09-memory.md
│   ├── save/          → 11-save.md
│   ├── store/         → 10-store.md
│   ├── system/        → 13-windows-tray-apps.md (audio)
│   ├── tray/          → 13-windows-tray-apps.md
│   ├── voice/         → 12-voice.md
│   └── windows/       → 13-windows-tray-apps.md
├── renderer/          → 14-renderer.md
├── scripts/           → 16-build.md (install-stt, etc.)
├── tests/             → 15-testing.md
└── package.json       → 16-build.md
```
