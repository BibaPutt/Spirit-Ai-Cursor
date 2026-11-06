# 06 — LLM Core (`electron/llm/*`)

Non-provider LLM plumbing: prompt building, model constants, templates,
message splitting, suggestion chips, and link metadata. Provider clients and
the router live in `llm/providers/*` (07) and tools in `llm/tools/*` (08).

## `prompt.ts`
- `SYSTEM_PROMPT` — the Spirit system prompt ("You are Spirit, an AI cursor
  assistant…"). Explains the trigger gesture, the context it receives
  (screenshot, clipboard, selection), and formatting rules.
- `applyTemplateVars(s)` — substitutes `{{TODAY}}` with the current date.
- `ContentBlock` — image / text content blocks for multimodal messages.
- `ToolCallPart` — `{ id, name, args }` for tool-call messages.
- `Message` — union of user / assistant / tool / tool-call messages
  (shared across providers).
- `buildMessages(...)` — assemble the final message array from system prompt,
  context, history, and the current user question (used by handlers).

## `models.ts`
- `MODELS` — model ids grouped by provider (the exact id strings sent to each
  API).
- `REASONING_EFFORT = 'minimal'` — used where the API supports a reasoning
  effort knob.
- `MAX_TOKENS = 2048` — default completion cap.
- `ROUND_TIMEOUT_MS = 150_000` — per-round timeout for the agentic loop.

## `templates.ts`
- `TemplateId` / `Template` — the built-in prompt templates: `summary`, `brief`,
  `translate`, `explain`, `code`, `improve`, `define`, `solve`, `reply`,
  `identify`. Each is a named prompt that reshapes the user's question (e.g.
  `translate` → "translate this…", `code` → "write code for…").
- `getTemplate(id)` / `listTemplates()`.

## `split.ts`
- `splitGoal(goal)` — tokenize a goal string for the scene menu goal scoring
  (see 04-capture).

## `chips.ts` + `chips-parse.ts`
Suggestion-chip generation, entirely text-driven (OCR + selection + app
context, no vision).
- `chips.ts` — `generateChipSuggestions(contextText)` calls a cheap model with
  `CHIP_SYSTEM_PROMPT` to produce up to 3 short action chips.
- `chips-parse.ts` — pure parsing/validation:
  - `SuggestionChip { label, action, iconName? }`, `MAX_CHIPS = 3`,
    `CHIP_LABEL_MAX = 45`, `ICON_NAME_MAX = 40`.
  - `SAFETY_MARKER` — model refusal text that must be rejected.
  - `parseChipSuggestions(raw)` — robust JSON-list parser with `normalizeIconName`.
  - `parseNextActionsFromAnswer(answer)` — parses the `[NEXT_ACTIONS] … [/NEXT_ACTIONS]`
    block appended to the main answer (see below). `NEXT_ACTIONS_OPEN/CLOSE`.
  - `cacheKeyFor(contextText)` — context hash used to cache suggestions.
  - `normalizeChipContext` / `textSimilarity` — context normalization and
    dedupe heuristics.

### `[NEXT_ACTIONS]` flow
The main answer may include a fenced `[NEXT_ACTIONS]` block listing follow-up
chips. `publishNextChipsFromAnswer` (in handlers) parses it, broadcasts the
chips to the renderer, and strips the block from the displayed text. On
`onFinalAnswer` the memory pipeline's `splitRememberSection` handles the
`Key takeaways:` section the same way (see 09).

## `point.ts`
The on-screen annotation protocol (Phase 4 POINT + Phase 7 annotations). Pure
module (no Electron imports) so it is fully unit-tested (`tests/point.test.ts`):
- Tags the model emits inline in its stream, in image-pixel space:
  `[POINT:x,y:label:screenN]`, `[BOX:x,y,w,h:label:screenN]`,
  `[BOX:el#:label]` (element id → real accessibility frame), and
  `[ARROW:x1,y1:x2,y2:label:screenN]` (label optional).
- `parsePoints` / `parseAnnotations` (story order across mixed kinds) /
  `stripAnnotations` (removes every tag so they never reach the answer, TTS,
  or history) / `annotationKey`.
- `createAnnotationScanner()` — incremental streaming scan: returns only the
  newly-completed tags per delta, content-addressed dedupe, never re-emits.
- `setCurrentPointGeo` / `getCurrentPointGeo` — the screenshot geometry the
  current image is mapped against.
- `mapPointToScreen` / `mapBoxToScreen` / `mapArrowToScreen` — image-pixel →
  absolute screen DIP (primary-monitor origin, the same space click/mouse use).

## `scene-cache.ts`
Main-side stash of the last scene elements built by `ui_read`/`ui_click`/`drag`
so answer-phase `[BOX:el#:label]` tags resolve to exact UIA/AX/OCR frames
without re-walking the tree. Cleared at the start of every query run so stale
element ids never box things from an earlier task. `resolveSceneElementFrame`
reuses `resolveElementById` (containers rejected).

## `link-meta.ts`
- `fetchLinkMeta(rawUrl)` — fetch a URL's `<title>` / description / icon to
  render a `LinkCard` in the pill (used when the answer contains links).

## `openrouter.ts`
Re-export shim: exports the OpenRouter provider client plus `StreamHandlers`
type for backward-compatible imports.
