# 14 — Renderer (`renderer/*`)

The React overlay UI. One renderer process per display; each is a transparent,
frameless, always-on-top window. The renderer is a **thin presenter + smart
engagement gate**: all native work happens in main, streamed over IPC.

## Entry
- `renderer/main.tsx` — React bootstrap.
- `renderer/App.tsx` — the single root component. Huge, deliberately: it owns
  all cross-cutting overlay behavior (see below).

## The `App.tsx` state model (per-display overlay)
Key pieces (mirrored in the code's own comments):

- **Display identity**: `displayId` / `isPrimary` / `platform` from the URL
  query (`?displayId=N&primary=1`) + `window.spirit.platform`.
- **Anchoring**: `useCursorPosition` feeds `pos`; `computeAnchor` (lib)
  places the pill near the cursor within screen bounds.
- **AI-mode state** via `useAIMode` (`active`); the pill only renders when
  `aiActiveHere = active && pos.displayId === displayId`.
- **LLM state** via `useLLMQuery`: `idle | loading | streaming | done |
  error`, plus the streamed `response`, `activities` (tool rows), and the
  `streamActiveRef`/`lastAnswerAtRef` used to preserve an in-flight or just-
  finished answer when the box hides.
- **Capture-mode**: `captureActive = aiActiveHere && !settingsOpen` — the
  overlay owns the mouse full-time (custom cursor, click-through forwards
  clicks/scrolls to the app underneath).
- **Box bounds + hover**: a 60fps RAF measures the pill rect but only pushes
  a state update when it changed ≥1px (`sameRect`) to avoid flicker and 60Hz
  IPC spam. Hysteresis (14px enter / 80px leave) prevents edge-wobble from
  toggling `setIgnoreMouseEvents` every frame.
- **Interactivity rule**: `interactive = aiActiveHere || settingsOpen ||
  bannerHovered` → `ipc.setInteractive(next)`. While interactive the overlay
  is click-receiving; otherwise click-through.
- **Auto-dismiss logic** (the clever part, heavily documented in code):
  - main broadcasts raw "user typing/clicking elsewhere" signals;
  - the renderer gates them: DISPLAY GATE (only the overlay on the cursor's
    display acts), OWN-KEYSTROKE GATE (a DOM keydown into our own input in
    the last 500ms is us, not them), ENGAGEMENT GATE (cursor inside the
    pill bounds = engaged), OWN-INPUT GUARD (hasFocus + activeElement in
    box), LLM-STATE gate (done/error keeps the box open — the user is using
    the answer), AGENT-TURN gate (tools running = user is watching the tool).
  - 3+ valid signals in 5s → auto-dismiss while loading/streaming.
  - **30s idle auto-dismiss**, bumped on engagement (typing into us, cursor
    inside box, mousedown in box, LLM turn finish). 2 min after `done`
    (the typical read→switch-app→come-back workflow). Tool turns suspend it.
- **Session window (~2 min)**: `lastResultRef` stashes the last shown result;
  on re-trigger within the window it's restored so hiding never loses the
  answer. `restoreLastResponse` in `useLLMQuery`.
- **Backdrop gestures**: right-click forwards a context-menu click; plain
  left-drag is **paint-to-select** (accent region, OCR'd into a bubble);
  trigger-held drag is **drag-to-screenshot** (`SelectionRectangle`);
  a drag that never crosses 6px resolves as a forwarded click + dismiss
  counter (double-click to dismiss by default, configurable).
- **Wheel forwarding**: accumulate deltas into notches, throttle to ≥90ms
  (never one PowerShell process per wheel event), negate sign (pyautogui
  convention).
- **Command handling**: `/help`, `/history`, `/lastsession`, `/clear`,
  `/settings`, `/quit`, plus template commands (handled inline in PromptInput).
- **Theme + accent**: `themePreference` (`system|light|dark` — note the
  codebase inverts: `html.dark` = light pill) and `accentColor`
  (lime/blue/magenta) set CSS vars `--accent`, `--accent-rgb`,
  `--accent-glow` so Tailwind utilities, inline styles, and SVG stops all
  retint live.

## Components (`components/`)

| Component | Purpose |
| --- | --- |
| `PromptInput.tsx` | The pill: textarea, mic, screenshot/clipboard chips, web toggle, template picker, submit. Re-exports `HELP_TEXT`/`COMMANDS`. Also renders the self-knowledge line (`learnedLine` prop, from `learned:hint`) — a quiet fading one-liner at the box bottom edge, hidden while streaming. File-drop target: dropped paths go through `files:attach`, attached names render as chips with one dismiss-all ✕. |
| `ResponsePill.tsx` | Stub/empty (see `App.tsx`). |
| `Markdown.tsx` | Render assistant text as Markdown (code blocks, tables, links). |
| `LinkCard.tsx` | Rich link preview card (from `fetchLinkMeta`). |
| `SuggestionChips.tsx` | Context-action chips (from `chips:result`). |
| `NextActionChips.tsx` | Follow-up chips from the `[NEXT_ACTIONS]` block. |
| `ChipsLoadingLine.tsx` | Animated placeholder while chips are pending. |
| `ToolActivity.tsx` | Live rows of running/done/error tools. |
| `ToolApproval.tsx` | Approve/deny prompt for approval-required tools. |
| `SettingsModal.tsx` | Full settings UI (providers, models, behavior, memory, voice, apps, autostart, theme/accent). Includes Memory toggles (context memory + session saving). The opencode card auto-persists (model, toggles, enable, URL, detected list) debounced without the main Save button; Detect refreshes the model list but never stomps user toggles (proxy lists carry no capability flags). |
| `PermissionsBanner.tsx` | macOS accessibility / screen-recording warnings. |
| `ProviderHealthBanner.tsx` | "A provider is broken (keychain decrypt)" banner with Open Settings. |
| `CursorHalo.tsx` | The glowing accent halo behind the cursor. |
| `SpiritCursor.tsx` + `cursorShapes.ts` | The branded custom cursor; morphs by `CursorPosition.shape` (arrow / I-beam / hand / slash / plus …). |
| `SelectionRectangle.tsx` | The drag-to-screenshot rectangle. |
| `sanitizeSchemas.ts` | Sanitizes tool JSON schemas for display/serialization. |

## Hooks (`hooks/`) — IPC bridges
| Hook | Subscribes to | Returns |
| --- | --- | --- |
| `useAIMode` | `ai-mode:start/end` | `{ active }` |
| `useCursorPosition` | `cursor:position` | `CursorPosition \| null` |
| `useSettings` | `settings:get/set` | `{ settings, loading, save }` |
| `useLLMQuery` | `llm:chunk/final/done/error/tool-activity` | state, response, activities, submit/reset/restore |
| `useChips` | `chips:result/pending`, `chips:next` | suggestion + next chips |
| `useClipboardContext` | `clipboard:context` | clipboard ctx + dismiss |
| `useSelectionContext` | `selection:context` | selection ctx + dismiss |
| `useAppContext` | `app:context` | foreground app preview |
| `useToolApprovals` | `llm:tool-approval-*` | requests + decide/clear |
| `useVoiceInput` | mic + `voice:transcribe/stt-status` | recording state + transcript |
| `useTTS` | `voice:synthesize` | speak/stop + playing state |
| `useHistory` | `sessions:list` | sessions + `formatHistoryMarkdown` |
| `useLinkMetas` | `external:fetch-meta` | link metadata cards |

## Lib (`lib/`)
- `ipc.ts` — the Proxy that exposes `window.spirit` as `SpiritAPI`.
- `positioning.ts` — pill placement math (`computeAnchor`).
- `commands.ts` — slash commands + templates + `HELP_TEXT`.
- `statusLines.ts` — animated status phrases while streaming.
- `voiceCommands.ts` — multi-language voice command phrases + matching
  (`matchVoiceCommand`, `isStopUtterance`, `effectiveVoiceLang`).
- `iconMatch.ts` — fuzzy icon resolution to Tabler icons.
- `animations.ts` — framer-motion presets (halo, pop).

## Styles (`styles/globals.css`)
Tailwind-style utilities + the theme system: `html.dark` toggles the light
pill; `--accent` / `--accent-rgb` / `--accent-glow` drive every accent surface
(Settings, halo, chips, selection rectangle). `renderer/main.tsx` applies an
initial `prefers-color-scheme` class to avoid a flash before settings load.

## Renderer types
`renderer/types.ts` is an empty module — all shared types come from
`electron/types.ts` (imported across the boundary).
