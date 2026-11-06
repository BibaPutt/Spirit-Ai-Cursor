# 08 — Tools (`electron/llm/tools/*`)

A **tool registry** for OpenAI-style function calling. Each tool has a
JSON-schema declaration sent to the model, an executor running in the main
process, and a short UI label for the activity row.

## Registry (`index.ts`)

```ts
type ToolDefinition = {
  declaration: ToolDeclaration;                 // JSON schema for the LLM
  execute: (args, ctx) => Promise<string>;      // runs on main process
  uiLabel: (args) => string;                    // "Fetching", "Opening", …
};
type ToolExecutionContext = {
  latestAssistantText: string;                  // in-flight answer (for save_document)
  originalPrompt: string;
  sessionGoal?: string;                         // original user goal (follow-up turns keep it)
  abort: AbortSignal;
};
```

- `TOOLS` — `Record<name, ToolDefinition>`; `getEnabledTools()` (all), `getToolDeclarations()` (for the LLM), `getTool(name)`, `executeTool(name, args, ctx)`, `describeToolForUI(name, args)`.
- Executor errors are caught and returned as `Error: …` strings so the model
  can recover, never thrown.

## The tools

| Tool | What it does | Approval |
| --- | --- | --- |
| `fetch_url` | Fetch a URL's content/text (respects robots/limits) | yes |
| `open_url` | Open a URL in the default browser | — |
| `copy_to_clipboard` | Write text to the clipboard | — |
| `save_document` | Save the in-flight answer to a file (Markdown/HTML) | — |
| `reveal_in_finder` | Reveal a file/folder in the OS file manager | — |
| `read_clipboard` | Read the clipboard text | — |
| `launch_app` | Launch an app (via `apps/launcher.ts`) | — |
| `play_music` | Start music/audio (platform player) | — |
| `search_web` | Web search, returns top results to the model | — |
| `set_volume` | Set system volume (`system/audio.ts`) | — |
| `type_text` | Type text into the focused app | — |
| `press_key` | Send a key combo (`input/actions.ts`) | — |
| `click` / `double_click` | Click / double-click at coordinates | — |
| `move_mouse` | Move the OS cursor | — |
| `scroll` | Scroll by delta lines | — |
| `wait` | Sleep (ms) | — |
| `see_screen` | Capture the target window + scene → text to the model | — |
| `ui_read` | Read the scene (windows/controls) around the cursor | — |
| `ui_click` | Click a scene element by id (`scene.ts` `resolveElementById`) | — |
| `read_table` | Parse HTML/RTF table in clipboard → CSV | — |
| `paste_table` | Build table HTML/CSV and copy to clipboard | — |
| `paste_image` | Copy an image (screenshot crop / clipboard image) | — |
| `drag` | Drag from one point to another | — |
| `read_file` | Read text file contents into context (capped, paged). Binary refused. | no |
| `edit_file` | Exact-block replace (unique-match guard) or append. Text-only. | yes |
| `list_dir` | List directory entries + sizes. | no |
| `compress_file` | Shrink images to smaller JPEG (new file by default). Non-images point at run_command/web fallback. | no |
| `task` | Fenced sub-agent loop for one goal (depth 1, no nesting). Nested approvals still fire. | yes |
| `question` | Schema-validated ask-the-user; model must emit the returned [QUESTIONS] verbatim. | no |
| `list_processes` | List running process names (tasklist/ps direct, no shell); optional `match` filter. Read-only, no approval. Use instead of run_command for "is X running". | no |
| `laya_decide` | Ask the local laya server (`:8000`) a tiny decision (intent/safety/relevant/pick/need-ground/direct presets). Read-only, no approval; falls back to plain text when the server is off. | no |
| `run_command` | Shell command (approval). Safety filter blocks destructive ops; `format` matches only `format X:` so PowerShell `Format-Table` stays allowed. | yes |

## Approval (`approval.ts`)

- `getApprovalRequiredTools()` — the set of tools that require explicit user
  consent (mutating/destructive ones: `fetch_url`, `click`-family, `type_text`,
  `press_key`, `drag`, `ui_click`, …).
- `isApprovalRequired(name)`.
- Approval flow: when the model calls an approval-required tool, the router
  emits `llm:tool-approval-request` → the pill shows a `ToolApproval` prompt →
  the user approves/denies via `llm:tool-approval-respond`. The agent loop
  pauses until a decision. Activity rows show the tool's `uiLabel` and final
  status (done/error).

## Cross-cutting

- Tools that touch the screen use `capture/scene.ts` (UI tree + rects) and
  `input/actions.ts` (real input synthesis) — see 04-capture, 05-input.
- `save_document` uses `save/template.ts` rendering (see 11-save).
- Adding a tool = one file exporting a `ToolDefinition`, plus an entry in
  `TOOLS` in `index.ts`. No other wiring needed.
