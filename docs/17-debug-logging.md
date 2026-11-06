# Debug Logging Guide

How to read the app's own logs, find the parameters you need, and capture the
**real input** shipped to the model for each question — so a weird answer can be
traced back to what the model actually saw.

## 1. Where the logs live

- Session logs: `logs/session-YYYYMMDD-HHMMSS-PID.log` (one file per run of the
  app). The newest run is the file with the latest `LastWriteTime`.
- Timestamps are **UTC**. Local time (IST) = log time + 5:30.
- Old logs are rotated/pruned automatically on startup.

Open the newest log file:

```powershell
Get-ChildItem logs | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty Name
```

## 2. Log tag index

Every line starts with `[tag]` — this is the fast lane for grepping:

| Tag | Meaning |
| --- | --- |
| `[main]` | Lifecycle: dev session start, global hook, AI-mode start/end |
| `[spirit]` | AI-mode start/end with display + trigger shape |
| `[overlay]` | Overlay window shows/hides, per-display |
| `[session]` | Conversation boundaries: `new session` / `resume turn N` |
| `[run]` | **THE INPUT for a turn** (relevance, sources, tokens, verbatim user text) |
| `[router]` | Assembled context size vs your `maxContextTokens` budget |
| `[agentic]` | The model loop: round sizes, raw output (`ai:`), tool plans/results, final answer |
| `[memory]` | Long-term recall hits (`[memory] recall="query" → N matched: id, ...`) |
| `[selection]` | Selected text captured at trigger time |
| `[app-context]` | Active app / tab / URL |
| `[chips]` | Action-chip generation (input, provider chain, result) |
| `[chips/ai]` | Overlay dismiss from the UI |
| `[tts]`, `[transcribe]`, `[local-stt]` | Voice pipeline (TTS, transcript, local sidecar) |
| `[forward-click]`, `[forward-scroll]` | Synthesized input |
| `[resource]` | Memory/CPU every 5 s (auto-on in dev) |
| `[settings]` | Settings/store cleanup |

## 3. The real input: `[run]`

Each submitted question prints a `[run]` block right before the model runs:

```
[run] turn=3 first=false relevance=unrelated msgs=14 imgParts=0 estTokens=1980 budget=6000 sources=[app] screenshot=no
[run] user-text (last 2000 chars):
what is widget
```

Every field is a needle for debugging:

| Field | Meaning |
| --- | --- |
| `turn` | Turn number in this session |
| `first` | `true` on the very first question of a session |
| `relevance` | `classifyScreenRelevance` verdict: `related` / `unrelated` |
| `msgs` | Number of messages shipped to the provider this turn |
| `imgParts` | Image parts in the whole payload (each ≈ 1500 tokens) |
| `estTokens` | Estimated total tokens (4 chars ≈ 1 token, image = 1500) |
| `budget` | Your `maxContextTokens` setting |
| `sources` | What passed the relevance gate: `ocr`, `clipboard`, `selection`, `paint`, `app` |
| `screenshot` | `yes`/`no` — was a fresh screenshot attached? |
| `user-text` | The last user message **verbatim** after all gating/stripping |

The golden rule: **`imgParts` + `sources` + `relevance` = what the model saw.**
If an unrelated follow-up still shows `imgParts>0`, the relevance gate failed.

## 4. The model loop: `[agentic]`

Each turn is answered inside an agentic loop (up to 8 rounds). The logs read
like a transcript:

```
[router] context input ≈1980 tokens (33% of budget 6000)   <- what fit at the start
[agentic] round 1: msgs=14 imgParts=0 estTokens=1980       <- what round 1 saw
[agentic] ai: (no text)
[agentic] plan: web_search({"query":"widget"})           <- tool call
[agentic] step: Reading search results for "widget"
[agentic] ok: Reading search results for "widget" -> [GROUNDED_SEARCH query="widget"]
[agentic] round 2: msgs=16 imgParts=0 estTokens=2340       <- AFTER tool result appended
[agentic] ai: A cow is a domesticated, long-horned ...
[agentic] final: A cow is a domesticated, long-horned ...
```

How to spot an overflow: compare `round 1` vs `round 2` `estTokens`. If round 2
exceeds the provider's real window (even when `budget` looks fine), the model is
reading garbage/truncated context — that is when answers stop making sense.

## 5. Searching for the parameters you need

### PowerShell (any terminal)

Latest turn inputs:

```powershell
$latest = (Get-ChildItem logs | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
Select-String -Path $latest -Pattern "\[run\]"
```

Reconstruct a full conversation (turns, inputs, final answers, memory):

```powershell
Select-String -Path logs\session-*.log -Pattern "\[session\]|\[run\] turn|\[agentic\] final|\[memory\] recall" | Select-Object -Last 200
```

Find over-budget / provider-window warnings:

```powershell
Select-String -Path logs\*.log -Pattern "exceeds budget|context input"
```

Everything a model did around a keyword (e.g. a topic, tool, or error):

```powershell
Select-String -Path logs\*.log -Pattern "widget|web_search|GROUNDED_SEARCH" -CaseSensitive:$false
```

Selected text + active app for a turn:

```powershell
Select-String -Path $latest -Pattern "\[selection\]|\[app-context\]"
```

### VS Code

`Ctrl+Shift+F` on the `logs` folder (path patterns, not full regex needed):
- `\[run\]` → every input
- `\[run] turn=\d+ relevance=unrelated` → questions the screen context was stripped from
- `exceeds budget` → overflow warnings
- `widget` → any topic across all sessions

## 6. Capturing real input for a bug report

1. Reproduce the question in the app.
2. Note the `[session] resume turn N` / `new session` line.
3. Copy the `[run]` block for that turn (the `user-text` paragraph IS the verbatim input after gating).
4. Copy the `[agentic]` lines for that turn (round sizes, `ai:`, `plan:`, `ok/failed:`, `final:`).
5. Include the `[router] context input` line and any `exceeds budget` warning.

That bundle is enough to tell whether the model saw the right input, lost
context to an overflow, or got garbage from a tool.

## 7. Notes & guardrails

- **No secrets are logged** — never API keys, never full base64 screenshots
  (only image *counts* and token estimates).
- `estTokens` is approximate by design (4 chars ≈ 1 token; each image = 1500).
- `[resource]` debug is auto-enabled in dev; force it in production builds with
  `SPIRIT_DEBUG_RESOURCE=1`.
- User-owned/never-edit files are unaffected; this logging covers
  `electron/ipc/handlers.ts` and `electron/llm/providers/router.ts` only.