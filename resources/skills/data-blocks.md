---
name: Structured data blocks
description: When your answer has ANY structure — stats, key/value facts, comparisons, steps, tables, choices, workflows, processes, sequences, or diagrams — render it as an interactive OpenUI, [QUESTIONS], [MERMAID], or [DIAGRAM] DATA block instead of a plain bullet wall.
defaultEnabled: true
triggers: [openui, ui, questions, mermaid, diagram, chart, table, wizard, comparison, dashboard, stats, metric, workflow, process, flowchart, compares, list of steps, pros, cons, decide, budget, timeline, architecture, sequence, pipeline, score, breakdown, headings]
---

# Custom UI, question wizards and diagrams — optional DATA blocks in the answer
You can include special DATA blocks in your answer that render as interactive UI. They are placed INLINE where they belong (never at the start or end), and the app strips the tags and renders the payload itself — never mention the tags or the payload in prose, never describe what you "put in the UI", never wrap them in extra text or brackets.

Default to a DATA block whenever the answer has ANY structure — a plain-text paragraph is the exception, not the rule:
- OpenUI (`[OPENUI]` … `[/OPENUI]`) is the DEFAULT for anything structured, visual, or interactive: dashboards, metrics, comparisons, tables, charts, plans, steps, forms, choices, and buttons. See the OpenUI Lang section appended at the end of this prompt for the exact component signatures — write the program there, do not invent components. Example: explaining an analytics dashboard (Sessions, Scroll depth, Active time, Users) → an OpenUI Card with a Table/BarChart and 1-2 metric cards.
- [UI] is the LEGACY card format — use it ONLY when the OpenUI block cannot express the content (rare) or when the answer is already being written in [UI] earlier in the same answer. Never mix both formats' payloads inside one block.
- [QUESTIONS] when you need the user to answer several questions (a mini form, a survey, preferences) so you can act on their answers.
- [MERMAID] when the answer is a workflow, process, architecture, sequence, state, flow, or relationship — draw it as a diagram. Whenever "then → then → then" or "A talks to B" appears in the answer, use [MERMAID].
- [DIAGRAM] when the answer is a diagram-like structure but Mermaid is overkill: hand-authored HTML using the app's fixed .dg-* template vocabulary (styled boxes, arrows, timelines, pipelines, compare grids, layers, trees, labeled terms). [MERMAID] is default for flows/graphs; reach for [DIAGRAM] when the content is mostly LABELS + CARDS with a little ordering (a release pipeline, a layered architecture stack, a pros/cons grid, a decision tree, an anatomy diagram).

[OPENUI] rules:
- The program is OpenUI Lang, NOT JSON: one statement per line, `name = Component(arg1, arg2, ...)`, positional arguments, `root = Card([...])` as the entry point, and every named statement referenced by a parent array.
- Put short prose AFTER the block. One [OPENUI] block per answer, 3-8 statements.
- Buttons must do something real: `@ToAssistant("follow-up prompt")` sends a new prompt, `@OpenUrl("https://…")` opens a link, `@Copy("text")` copies. Never a dead button.
- The full component list and examples are in the "Structured answers use OpenUI Lang" section at the end of this prompt. If a component is not listed there, it does not exist — do not guess.

Title rules: OpenUI uses a `CardHeader("Title")` (or `InlineHeader`) as its visible title; the streaming tile reads the first header string. For the other formats, each block begins with its SHORT TITLE emitted right after the opening tag, before the payload. While the block streams, the app shows a small tile with that title instead of the raw payload, so the title MUST come first:

[UI]
{"title":"Comparison","t":"card","title":"…","children":[…]}

[/UI]

[QUESTIONS]
{"title":"Settings check","questions":[{"q":"…","type":"radio","options":["a","b"]},…]}

[/QUESTIONS]

[MERMAID]
%% User flow
graph TD; A-->B;

[/MERMAID]

[DIAGRAM]
%% Release pipeline
<div class="dg-flow">
  <div class="dg-box dg-accent">Build</div>
  <div class="dg-arrow"></div>
  <div class="dg-box">Test</div>
  <div class="dg-arrow"></div>
  <div class="dg-box">Deploy</div>
</div>

[/DIAGRAM]

Title rules: keep it 1–4 words ("Server stats", "Budget quiz", "Deploy pipeline"). For [UI]/[QUESTIONS] put it as the literal string "title" at the START of the JSON object (never last — the tile can't wait for the end of the block). For [MERMAID] and [DIAGRAM] the very FIRST line must be a `%% <title>` comment ("%% title: Deploy pipeline" also works) — a block with no `%%` first line gets the fallback title "Diagram". Never put title text anywhere else in the block.

[UI] component vocabulary (JSON object per node; ALL fields optional):
- Containers: {"t":"card"|"section"|"row"|"grid","title":"…","children":[…]}. grid may carry "cols":2-6.
- Info: {"t":"heading","text":"…"} | {"t":"text","text":"…"} | {"t":"badge","text":"…","variant":"…"} | {"t":"code","text":"…"} | {"t":"quote","text":"…"} | {"t":"link","text":"…","href":"https://…"} | {"t":"divider"}
- Structured: {"t":"kv","items":[["Key","Value"],…]} | {"t":"table","headers":["A","B"],"rows":[["1","2"]]} | {"t":"stat","label":"CPU","text":"42%","delta":"+3%"} | {"t":"steps","items":["step1","step2"]} | {"t":"list","items":["…"]} | {"t":"progress","value":70} | {"t":"timeline","items":["…"]}
- Controls (each has "name" — the value is collected and reused): {"t":"button","label":"Save","action":"send"|"copy"|"reset","prompt":"…"} | {"t":"toggle","name":"x","default":true} | {"t":"slider","name":"x","min":0,"max":100} | {"t":"select"|"radio"|"multiselect","name":"x","options":["a","b"]} | {"t":"text"|"textarea"|"password"|"number"|"date","name":"x","default":"…"}
- Children accept either objects or plain strings (a string is a text line).
- "variant" shades — NEVER raw colors: strong, accent (default), soft, ghost, neutral, success, warning, danger. The app tints them with the current accent color automatically.
- "prompt" on a send button: the action submitted when tapped. {name} placeholders are replaced with the matching control's current value, e.g. {"t":"button","label":"Apply","action":"send","prompt":"Apply theme={theme} with volume {vol}"}.

[QUESTIONS] rules:
- "type" is one of: radio, slider, multi (multi-select), select, text, textarea, number, date, checkbox, toggle.
- "options" (for radio/select/multi/checkbox) is an array of plain strings or {label,value} objects.
- 1–12 questions, each "q" a short clear question in the user's language. Required answers: "required":true. Keep it tight — ask only what you truly need.
- The app builds the wizard (Next/Back/Skip, "Question 2 of 5", progress, confirmation screen) and submits the user's answers back to you on Finish.
- When the user's next message starts with "Your answers to the questions you asked:", ACT on those answers immediately. Never repeat your previous answer and never re-ask the same questions. If the questions were a quiz/test, grade each answer and present a [UI] scoreboard card — a "score" stat (e.g. "3/5") plus a per-question list showing which were correct/incorrect. If they were clarifying questions, use the answers to complete the user's actual request in THIS response.

[MERMAID] rules:
- Plain diagram source only — no JSON. Common types: graph TD/LR, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt, pie, journey, mindmap.
- Keep it compact (a few nodes/edges), valid Mermaid syntax, no external images/links.

[DIAGRAM] rules:
- Plain HTML only, built from these fixed classes — the app styles them with the current theme. NEVER use inline style, hex/colour, coordinates, <img>, <a>, or <style> — they are stripped anyway. Each element: ONE class (plus optional dg-accent on a dg-box).
- Layout: `dg-flow` (vertical), `dg-flow-h` (horizontal wrap), `dg-row` / `dg-col`, `dg-grid` (auto columns), `dg-pair` (two columns), `dg-stack`, `dg-tree` (indented branches).
- Cards & text: `dg-box` (card), `dg-accent` (accent card), `dg-title` / `dg-box-title` (headings), `dg-box-sub` (subtitle), `dg-label` (tiny uppercase), `dg-muted` (faint text).
- Pills: `dg-badge` (accent pill), `dg-chip`, `dg-tag`, `dg-number` (numbered circle).
- Connectors: `dg-arrow` (down), `dg-arrow-h` (right), `dg-rule` (divider).
- Composites: `dg-step` (numbered step row), `dg-layer` (stacked layer), `dg-term` + `dg-term-desc` (term → definition).
- Keep 2–8 words per box, always close your tags, and never put content OUTSIDE the `[DIAGRAM]`…`[/DIAGRAM]` block.

When in doubt, INCLUDE the block — structured content shown as an OpenUI card, an OpenUI chart/table, or a [MERMAID] diagram is virtually always better than the same content as prose, and the blocks render as real widgets. Only skip them for genuinely tiny (1-2 line) answers, pure code, or a single isolated fact. The blocks are data and are removed before the answer is shown.
