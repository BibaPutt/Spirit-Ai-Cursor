# 03 — IPC: Preload, Channels, Handlers, Types

The renderer never touches Node/Electron directly. Everything crosses the
bridge defined by `electron/types.ts` (`SpiritAPI`), implemented in
`electron/preload.ts`, and served by `electron/ipc/handlers.ts`.

## The bridge

- `electron/preload.ts` exposes `window.spirit` via `contextBridge` with
  `contextIsolation`. Every exposed function is a thin `ipcRenderer.invoke`
  / `ipcRenderer.send` or a subscription wrapper `on(channel, cb)` that returns
  an unsubscribe function.
- The renderer consumes it through a Proxy (`renderer/lib/ipc.ts`) that looks
  up methods on `window.spirit` lazily.

## Channel naming

Channels are centralized in `electron/ipc/channels.ts`. Examples (see the
source for the complete list):

- `ai-mode:start` / `ai-mode:end` / `ai-mode:cancel` — overlay lifecycle
- `cursor:position` — global cursor position feed
- `llm:query` / `llm:query-options` / `llm:chunk` / `llm:final` /
  `llm:done` / `llm:error` — query & streaming
- `llm:tool-activity` / `llm:tool-approval-request` /
  `llm:tool-approval-cleared` / `llm:tool-approval-respond` — tool events
- `settings:get` / `settings:set` / `settings:open` — settings
- `permissions:get` / `permissions:open` — macOS permissions
- `clipboard:context` / `clipboard:dismiss` / `selection:context` /
  `selection:dismiss` / `selection:capture` / `selection:done` /
  `selection:arm` / `paint:capture` / `paint:remove` — context captures
- `app:context` — foreground app identity
- `external:open` / `external:fetch-meta` — open URLs, link metadata
- `text:insert` — type text into the focused app
- `input:forward-click` / `input:forward-scroll` — click/scroll forwarding
- `overlay:set-interactive` / `overlay:capture-mode` / `overlay:settings-mode`
  / `box:bounds` — overlay behavior
- `response:save` / `workspace:pick` / `app:version` / `sessions:*` /
  `voice:transcribe` / `voice:stt-status` / `voice:synthesize` /
  `provider:test-key` / `providers:health` / `provider:has-key` /
  `provider:has-any-configured` / `provider:reveal-key` /
  `autostart:get` / `autostart:set` / `apps:launch` / `apps:list` /
  `app:quit`
- `learned:hint` — main-to-renderer self-knowledge line (`{ text }`) when the
  agent learns something durable; the box shows it quietly at its bottom edge
  (see 14-renderer, 09-memory)
- `files:attach` / `files:attached` / `files:dismiss` — drag-drop file attach:
  renderer posts paths, main reads (text inline, images as vision blocks),
  broadcasts `AttachedFile[]` summaries for the chip row

## Handlers (`electron/ipc/handlers.ts`)

The largest file in the app. Key responsibilities:

- `runQuery(prompt, options)` — full query pipeline:
  - builds `Message[]` (system prompt, context, history),
  - injects recalled context memory via `withMemoryBlock` (see 09-memory),
  - truncates to the budget (`truncateForBudget`),
  - drives the provider router, streaming `llm:chunk`, then `llm:final`.
  - `onFinalAnswer` strips `[NEXT_ACTIONS]` (via `publishNextChipsFromAnswer`)
    and splits the `Key takeaways:` section (`splitRememberSection`) to collect
    per-turn takeaways; `onDone` fallback-strips takeaways, commits the cleaned
    assistant text, strips the memory block from the committed system message
    on the first turn, and fire-and-forgets `rememberTakeaways` when context
    memory is enabled.
- Trigger start/end/cancel, session window management (`extendSessionWindow`,
  `newSessionId`).
- Screenshot / selection / clipboard / paint / app-context capture entry
  points used by `main.ts`.
- Settings read/write (with secure key handling), permissions, external open,
  text insert, save response, sessions list/load/reveal/clear, voice
  transcribe/synthesize, STT status, provider key testing & health probing,
  launchable-app listing/launching.

## Types (`electron/types.ts`)

Shared across main/preload/renderer:

- `AIModeState`, `ActiveSession`, `Message`, `ProviderId`, `ProviderSettings`
- `CursorPosition { x, y, displayId, shape }`
- `TemplateId` — the built-in prompt templates:
  `summary, brief, translate, explain, code, improve, define, solve, reply,
  identify`
- `LLMChunk` / `LLMFinal` / `LLMError` — streaming payloads
- `ToolActivity`, `ToolApprovalRequest`
- `Settings` (theme, provider configs, memory toggles,
  etc.)
- `SpiritAPI` — the full contract implemented by `preload.ts`.

> Changing any of these requires updating `types.ts` → `preload.ts` →
> `handlers.ts` → renderer consumers. Keep them in lockstep.
