# 01 — Architecture

## Overview

Spirit is an Electron desktop app: a **main process** (Node, all native/OS
work) plus **renderer processes** (one transparent, always-on-top, frameless
window per display, showing the prompt pill and response).

The product loop:

1. User holds the **trigger key** (Right-Cmd on macOS / configurable).
2. A global input hook detects the gesture and opens the pill overlay at the
   cursor position on the correct display.
3. The app captures context: screenshot of the display under the cursor, the
   current clipboard, the on-screen text selection, the foreground app + active
   browser tab, and (optionally) OCR of the scene.
4. The user types a question (or picks a template / suggestion chip, or speaks
   via voice input).
5. The main process builds a message list (system prompt + context block +
   history), truncates to the token budget, runs the provider chain, and
   streams the answer back to the pill.
6. While answering, the model may call **tools** (click, type, save, search…)
   with per-tool approval. Tool activity appears as live rows in the pill.
7. On completion, the app strips presentation markers (`[NEXT_ACTIONS]`,
   `Key takeaways:`), optionally **remembers** the takeaway into context
   memory, persists the session, and shows follow-up "next action" chips.

## Process / context-flow diagram

```
                      ┌───────────────────────────────┐
 user triggers        │  main process                 │
 ───────────────────▶ │  input/global-hook            │
   (Right-Cmd held)   │  input/trigger                │
                      │      │                        │
                      │      ├─ capture/clipboard     │
                      │      ├─ capture/selection     │
                      │      ├─ capture/app-context   │
                      │      ├─ capture/screenshot    │
                      │      └─ broadcastAIModeStart  │
                      │             │                 │
                      │   ┌─────────▼──────────┐      │
                      │   │ overlay window     │      │
                      │   │ (renderer, React)  │      │
                      │   └─────────┬──────────┘      │
                      │        llm:query-options      │
                      │             │                 │
                      │   ipc/handlers.runQuery       │
                      │      │  + memory/recall       │
                      │      ▼                        │
                      │   llm/providers/router        │
                      │      │  (chain: OpenRouter →  │
                      │      │   Anthropic → OpenAI → │
                      │      │   Gemini → LocalAI)    │
                      │      │                        │
                      │   llm/tools loop (approval)   │
                      │      │                        │
                      │   └─── llm:chunk / final ────▶│
                      │             │                 │
                      │   onDone: remember takeaway,  │
                      │   persist session, next chips │
                      └──────────────┬────────────────┘
                                     ▼
                          workspace folder:
                          sessions/*.json(+html)
                          context-memory.json
```

## Tech stack

- **Electron** (main + preload + renderer), `contextIsolation` on,
  `nodeIntegration` off — the renderer only talks through the preload bridge.
- **React 18 + Vite** for the overlay UI; **Tailwind-style CSS** in
  `renderer/styles/globals.css`; **framer-motion** for the pill animations.
- **uiohook-napi** — native global keyboard/mouse hook (main process).
- **TypeScript** strict for both tsconfigs (`tsconfig.json` renderer,
  `tsconfig.node.json` main).
- **Vitest** for unit tests.
- **safeStorage** (Electron) for OS-keyring-backed API key encryption.
- Providers are plain HTTPS/SSE clients (OpenRouter, Anthropic, OpenAI,
  Gemini, LocalAI) — no SDKs, hand-rolled fetch + stream parsing.

## Runtime data flow (query)

1. `renderer/hooks/useLLMQuery.ts` `submit()` invokes `llm:query-options`.
2. `electron/ipc/handlers.ts` `runQuery`:
   - appends user message, reads `activeSession` context (screenshot OCR,
     clipboard, selection, paint selections, app context),
   - calls `withMemoryBlock(messages, prompt, screenContext)` to inject
     recalled memories when `contextMemoryEnabled`,
   - truncates to `getMaxContextTokens()` budget,
   - calls `router.runPlainCompletion`, wiring chunk/final/error events.
3. Router resolves an API key through the **provider chain**, streams chunks,
   and when the model emits a **tool call**, the tools loop executes it
   (after approval) and continues.
4. `onFinalAnswer` sanitizes the text; `onDone` commits the assistant message,
   runs `rememberTakeaways`, persists the session, and computes next-action
   chips.

## Key architectural decisions

- **Overlay per display** — one BrowserWindow per monitor, click-through
  except where interactive; custom cursor ("capture mode") during AI sessions.
- **Main owns all native context** (screenshots, clipboard, selection, hook,
  tools). Renderer is a thin presenter + engagement gate.
- **Session window ~2 min** — a "session" (screenshot + history) survives box
  hide/show within the TTL so follow-ups stay attached.
- **No telemetry, no analytics, no cloud** — everything (including memory) is
  local to the machine / workspace folder.

## Data locations

| Data | Location |
| --- | --- |
| Settings (`config.json`) | Electron `userData` dir |
| API keys | `config.json` `providers` map, encrypted via safeStorage |
| Sessions | `<workspace>/sessions/*.json` + `*.html` |
| Context memory | `<workspace>/context-memory.json` |
| Workspace folder | picked by the user (defaults under user home) |

See [09-memory.md](09-memory.md), [10-store.md](10-store.md),
[16-build.md](16-build.md).
