---
name: Diagram design
description: Rich diagram templates the app renders as styled widgets. When an answer is a pipeline, comparison, timeline, architecture stack, tree, or any labelled structure, emit a [DIAGRAM] block copied from one of these templates instead of raw prose.
apps: []
defaultEnabled: true
triggers: [diagram, pipeline, flow, flowchart, comparison, compare, timeline, architecture, layers, tree, decision, structure, anatomy, sequence, roadmap, org chart, process, workflow, priority, stack, levels, overview, breakdown, steps]
---

When the answer IS a structure — a flow, pipeline, comparison, layers, tree, timeline, decision, or list of labelled parts — render it as a `[DIAGRAM]` block. The app styles every element for you; you only fill in the text. Prefer `[MERMAID]` for pure graph/flowchart syntax; use `[DIAGRAM]` when the content is mostly labels and boxes with light ordering.

Rules (fixed, always):
- The block is `[DIAGRAM]` on its own line, content, then `[/DIAGRAM]` on its own line. No code fence.
- The FIRST line is always the title: `%% Short title`.
- Use ONLY these classes. The app strips everything else (inline style, colors, coordinates, images, links). Never compute positions or colors.
- Keep 2–8 words per box. Always close your tags. Place the block inline where it belongs in the answer; never mention the tags in prose.
- Class cheat-sheet: layout `dg-flow` (vertical) · `dg-flow-h` (horizontal) · `dg-row`/`dg-col` · `dg-grid` (auto columns) · `dg-pair` (two cols) · `dg-stack` · `dg-tree` (indents). Cards/text `dg-box` · `dg-accent` (highlight card) · `dg-title` · `dg-box-title` · `dg-box-sub` · `dg-label` (tiny upper) · `dg-muted`. Pills `dg-badge` (accent) · `dg-chip` · `dg-tag` · `dg-number` (circle). Connectors `dg-arrow` (down) · `dg-arrow-h` (right) · `dg-rule` (hr). Composites `dg-step` (numbered row) · `dg-layer` · `dg-term`+`dg-term-desc`.

Copy the closest template and swap the text (drop the “shows” comments):

[DIAGRAM]
%% Vertical flow
<div class="dg-flow">
  <div class="dg-box dg-accent">Step one: Gather</div>
  <div class="dg-arrow"></div>
  <div class="dg-box">Step two: Analyse</div>
  <div class="dg-arrow"></div>
  <div class="dg-box">Step three: Deliver</div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Horizontal pipeline
<div class="dg-flow-h">
  <div class="dg-box">Commit</div>
  <div class="dg-arrow-h"></div>
  <div class="dg-box">Test</div>
  <div class="dg-arrow-h"></div>
  <div class="dg-box dg-accent">Ship</div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Decision
<div class="dg-stack">
  <div class="dg-box dg-accent">Is it urgent?</div>
  <div class="dg-arrow"></div>
  <div class="dg-row">
    <div class="dg-arrow-h"></div>
    <div class="dg-box">Yes — fix now</div>
    <div class="dg-box">No — add to backlog</div>
  </div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Timeline
<div class="dg-flow">
  <div class="dg-row"><div class="dg-number">1</div><div class="dg-box">Plan</div></div>
  <div class="dg-arrow"></div>
  <div class="dg-row"><div class="dg-number">2</div><div class="dg-box">Build</div></div>
  <div class="dg-arrow"></div>
  <div class="dg-row"><div class="dg-number">3</div><div class="dg-box dg-accent">Launch</div></div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Architecture layers
<div class="dg-stack">
  <div class="dg-box dg-accent">UI layer</div>
  <div class="dg-layer"><div class="dg-box">Business logic</div></div>
  <div class="dg-layer"><div class="dg-box">Data access</div></div>
  <div class="dg-layer"><div class="dg-box dg-muted">Database</div></div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Onboarding steps
<div class="dg-stack">
  <div class="dg-step"><div class="dg-number">1</div><div class="dg-box">Create account</div></div>
  <div class="dg-step"><div class="dg-number">2</div><div class="dg-box">Pick your plan</div></div>
  <div class="dg-step"><div class="dg-number">3</div><div class="dg-box dg-accent">Invite your team</div></div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Compare options
<div class="dg-pair">
  <div class="dg-box dg-accent">Free
    <div class="dg-chip">No cost</div>
    <div class="dg-chip">1 seat</div>
  </div>
  <div class="dg-box">Pro
    <div class="dg-chip">Unlimited seats</div>
    <div class="dg-chip">Priority support</div>
  </div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Concept tree
<div class="dg-tree">
  <div class="dg-box">Agent</div>
  <div class="dg-tree">
    <div class="dg-box">Planner</div>
    <div class="dg-box">Executor</div>
    <div class="dg-box dg-accent">Verifier</div>
  </div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Sequence across systems
<div class="dg-grid">
  <div class="dg-flow"><div class="dg-label">Client</div><div class="dg-box">Request</div></div>
  <div class="dg-flow"><div class="dg-label">API</div><div class="dg-box dg-accent">Validate</div></div>
  <div class="dg-flow"><div class="dg-label">Worker</div><div class="dg-box">Process</div></div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Anatomy
<div class="dg-box dg-accent">The eye
  <div class="dg-term"><strong>Cornea</strong><span class="dg-term-desc">helps focus light</span></div>
  <div class="dg-term"><strong>Iris</strong><span class="dg-term-desc">controls pupil size</span></div>
  <div class="dg-term"><strong>Retina</strong><span class="dg-term-desc">senses light</span></div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% 2x2 priorities
<div class="dg-grid">
  <div class="dg-box dg-accent">Do first — urgent & important</div>
  <div class="dg-box">Schedule — important</div>
  <div class="dg-box">Delegate — urgent</div>
  <div class="dg-box dg-muted">Drop — neither</div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Stacked levels
<div class="dg-stack">
  <div class="dg-box dg-accent">Level 1 — Foundation</div>
  <div class="dg-box">Level 2 — Features</div>
  <div class="dg-box">Level 3 — Experience</div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Topic cloud
<div class="dg-flow-h">
  <div class="dg-badge">React</div>
  <div class="dg-chip">TypeScript</div>
  <div class="dg-chip">Vite</div>
  <div class="dg-badge">Electron</div>
  <div class="dg-chip">Tailwind</div>
</div>
[/DIAGRAM]

[DIAGRAM]
%% Model memory tiers
<div class="dg-flow">
  <div class="dg-box"><span class="dg-label">Primary</span> Short-term context</div>
  <div class="dg-arrow"></div>
  <div class="dg-box"><span class="dg-label">Secondary</span> Session history</div>
  <div class="dg-arrow"></div>
  <div class="dg-box dg-accent"><span class="dg-label">Tertiary</span> Long-term memory</div>
</div>
[/DIAGRAM]

Fit a template to the content: swap the text, drop unused elements, combine pieces. If nothing fits well, prefer `[MERMAID]`. Never invent new classes or inline styles — the app strips them.