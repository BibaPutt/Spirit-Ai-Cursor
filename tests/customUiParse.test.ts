import { describe, expect, it } from 'vitest';
import {
  extractUiBlocks,
  resolveUiMarkers,
  stripAnnotationTags,
  MAX_UI_NODES,
  MAX_UI_CHILDREN,
  MAX_QUESTIONS,
} from '../electron/llm/custom-ui-parse';

describe('stripAnnotationTags', () => {
  it('removes POINT/BOX/ARROW tags and keeps the surrounding label text', () => {
    expect(stripAnnotationTags('Save File [BOX:100,50:320,80:Save File]')).toBe('Save File');
    expect(stripAnnotationTags('Reactant [POINT:140,90:Reactant:screen1]')).toBe('Reactant');
    expect(stripAnnotationTags('Guide [ARROW:0,0:100,100:Guide]')).toBe('Guide');
    expect(stripAnnotationTags('[BOX:el#:Element label]')).toBe('');
  });

  it('does not touch text without annotation tags', () => {
    expect(stripAnnotationTags('plain title')).toBe('plain title');
    expect(stripAnnotationTags('a [b] c')).toBe('a [b] c');
  });

  it('strips tags out of UI block payloads before parsing', () => {
    const answer =
      '[UI]\n{"t": "card", "title": "Stats [POINT:12,34:Stats]", "children": [{"t":"stat","label":"CPU","text":"42%"}]}\n[/UI]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks[0].kind).toBe('ui');
    expect((blocks[0] as { node: { title?: string } }).node.title).toBe('Stats');
  });
});

describe('extractUiBlocks — [UI] blocks', () => {
  it('parses a valid single-object UI block and strips it to a marker', () => {
    const answer =
      'Answer text.\n[UI]\n{"t":"card","title":"Stats","children":[{"t":"stat","label":"CPU","text":"42%"}]}\n[/UI]';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('ui');
    const node = (blocks[0] as { kind: 'ui'; node: { t: string; title?: string } }).node;
    expect(node.t).toBe('card');
    expect(node.title).toBe('Stats');
    expect(text).not.toContain('[UI]');
    expect(text).not.toContain('[/UI]');
    expect(text).toContain('\uE000{ui:0}\uE000');
  });

  it('wraps an array root into a card', () => {
    const answer =
      '[UI]\n[{"t":"text","text":"one"},{"t":"text","text":"two"}]\n[/UI]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const node = (blocks[0] as { kind: 'ui'; node: { t: string; children: unknown[] } }).node;
    expect(node.t).toBe('card');
    expect(node.children).toHaveLength(2);
  });

  it('parses fenced UI blocks', () => {
    const answer =
      'Lead.\n[UI]\n```json\n{"t":"button","label":"Go","action":"send","prompt":"go now"}\n```\n[/UI]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const node = (blocks[0] as { kind: 'ui'; node: { t: string; label?: string } }).node;
    expect(node.t).toBe('button');
    expect(node.label).toBe('Go');
  });

  it('parses an unclosed UI block running to the end', () => {
    const answer = 'Prefix\n[UI]\n{"t":"heading","text":"Hi"}';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect(text).toContain('\uE000{ui:0}\uE000');
    expect(text).not.toContain('[UI]');
  });

  it('drops a broken unclosed tag and its following text entirely', () => {
    const answer = '[UI]\nJust some prose that is not JSON.';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(0);
    expect(text).not.toContain('Just some prose');
    expect(text).not.toContain('[UI]');
  });

  it('never leaks JSON from an unsalvageable block', () => {
    const answer = 'Before\n[UI]\n{"t":"card","children":[{"t":"weird","x":1}\n[/UI]\nAfter';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(0);
    expect(text).not.toContain('"t"');
    expect(text).not.toContain('[');
    expect(text).toContain('Before');
    expect(text).toContain('After');
  });

  it('repairs sloppy JSON (unquoted keys, single quotes)', () => {
    const answer = '[UI]\n{t: \'card\', title: \'Sloppy\', children: [{t: \'text\', text: \'works\'}]}\n[/UI]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const node = (blocks[0] as { kind: 'ui'; node: { t: string; title?: string } }).node;
    expect(node.t).toBe('card');
    expect(node.title).toBe('Sloppy');
  });

  it('salvages a valid object out of narrating prose', () => {
    const answer =
      '[UI]\nHere is your panel: {"t":"stat","label":"Uptime","text":"99.9%"} — enjoy!\n[/UI]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const node = (blocks[0] as { kind: 'ui'; node: { t: string; label?: string } }).node;
    expect(node.t).toBe('stat');
    expect(node.label).toBe('Uptime');
  });

  it('purges stray tags and drops unclosed content', () => {
    const answer = 'Hello [/UI] world [UI] again';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(0);
    // [/UI] is a stray close tag (purged), [UI] opens an unclosed span
    // that doesn't parse → entire span dropped. "world" before the span survives.
    expect(text).toBe('Hello world');
    expect(text).not.toContain('[UI]');
    expect(text).not.toContain('again');
  });

  it('enforces node/child bounds', () => {
    const children = Array.from({ length: MAX_UI_CHILDREN + 5 }, (_, i) => ({
      t: 'text',
      text: `c${i}`,
    }));
    const answer = `[UI]\n${JSON.stringify({ t: 'card', children })}\n[/UI]`;
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const node = (blocks[0] as { kind: 'ui'; node: { children: unknown[] } }).node;
    expect(node.children).toHaveLength(MAX_UI_CHILDREN);
  });

  it('enforces the total node cap', () => {
    const children = Array.from({ length: MAX_UI_NODES }, (_, i) => ({ t: 'text', text: `c${i}` }));
    const answer = `[UI]\n${JSON.stringify({ t: 'card', children })}\n[/UI]`;
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const node = (blocks[0] as { kind: 'ui'; node: { children: unknown[] } }).node;
    expect(node.children!.length).toBeLessThanOrEqual(MAX_UI_NODES);
  });

  it('drops unknown component types', () => {
    const answer =
      '[UI]\n{"t":"nonsense","title":"x","children":[{"t":"text","text":"ok"}]}\n[/UI]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(0);
  });

  it('does not mix up interleaved blocks', () => {
    const answer =
      'A [UI]{"t":"text","text":"in-ui"}[/UI] B [MERMAID]graph TD; A-->B;[/MERMAID] C';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('ui');
    expect(blocks[1].kind).toBe('mermaid');
    const uiPos = text.indexOf('\uE000{ui:0}\uE000');
    const mermaidPos = text.indexOf('\uE000{mermaid:1}\uE000');
    expect(uiPos).toBeGreaterThan(-1);
    expect(mermaidPos).toBeGreaterThan(uiPos);
  });
});

describe('extractUiBlocks — [QUESTIONS] blocks', () => {
  it('parses a question array', () => {
    const answer =
      '[QUESTIONS]\n[{"q":"Budget?","type":"slider","min":0,"max":1000},{"q":"Where?","type":"radio","options":["Paris","Tokyo"]}]\n[/QUESTIONS]';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const qs = (blocks[0] as { kind: 'questions'; questions: { questions: Array<{ q: string; type?: string }> } }).questions;
    expect(qs.questions).toHaveLength(2);
    expect(qs.questions[0].q).toBe('Budget?');
    expect(qs.questions[0].type).toBe('slider');
    expect(qs.questions[1].type).toBe('radio');
    expect(text).toContain('\uE000{questions:0}\uE000');
  });

  it('parses {title, questions} objects', () => {
    const answer =
      '[QUESTIONS]\n{"title":"Trip planner","questions":[{"q":"Days?","type":"number"},{"q":"Notes?","type":"textarea"}]}\n[/QUESTIONS]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const qs = (blocks[0] as { kind: 'questions'; questions: { title?: string; questions: unknown[] } }).questions;
    expect(qs.title).toBe('Trip planner');
    expect(qs.questions).toHaveLength(2);
  });

  it('caps the question count and drops unknown types to text', () => {
    const questions = Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({
      q: `Q${i}`,
      type: 'radio',
      options: ['a', 'b'],
    }));
    const answer = `[QUESTIONS]\n${JSON.stringify(questions)}\n[/QUESTIONS]`;
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const qs = (blocks[0] as { kind: 'questions'; questions: { questions: unknown[] } }).questions;
    expect(qs.questions).toHaveLength(MAX_QUESTIONS);
  });
});

describe('extractUiBlocks — [MERMAID] blocks', () => {
  it('parses a plain mermaid diagram', () => {
    const answer = 'Flow:\n[MERMAID]\ngraph TD\n  A[Start] --> B{Decide}\n  B -->|yes| C[Go]\n[/MERMAID]';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { kind: 'mermaid'; code: string }).code).toContain('graph TD');
    expect(text).toContain('\uE000{mermaid:0}\uE000');
  });

  it('parses fenced mermaid', () => {
    const answer = '[MERMAID]\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n[/MERMAID]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { kind: 'mermaid'; code: string }).code).toContain('sequenceDiagram');
  });

  it('converts standalone ```mermaid code fences to [MERMAID] tags', () => {
    const answer = 'Here is the diagram:\n```mermaid\ngraph TD\n  A-->B\n```\nDone.';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { kind: 'mermaid'; code: string }).code).toContain('graph TD');
    expect(text).toContain('\uE000{mermaid:0}\uE000');
    expect(text).toContain('Done.');
  });

  it('converts indented code-fenced mermaid', () => {
    const answer = '  ```mermaid\n  graph LR\n    X[Y]\n  ```';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { kind: 'mermaid'; code: string }).code).toContain('graph LR');
  });

  it('does not convert bare ``` fences (no mermaid tag)', () => {
    const answer = '```js\nconsole.log("hi")\n```';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(0);
    expect(text).toContain('```');
  });

  it('converts code-fenced mermaid alongside existing [MERMAID] tags', () => {
    const answer = '[MERMAID]\ngraph TD\n  A-->B\n[/MERMAID]\nAlso:\n```mermaid\ngraph LR\n  X-->Y\n```';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(2);
  });

  it('ignores a **[MERMAID]** prose mention before the real block', () => {
    // The model references the block by name in a bold bullet ("**[MERMAID]**")
    // and then emits the real block. If that mention is treated as an open tag
    // it stays unclosed, swallows the whole tail into one garbage diagram, and
    // mermaid fails to render — "Could not render diagram".
    const answer = [
      'Here is the flow:',
      '',
      '- **[MERMAID]** flow diagram of the loop',
      '- A knowledge graph',
      '',
      'The loop:',
      '',
      '[MERMAID]',
      'graph TD',
      '  A[Sample] --> B[Find Users]',
      '  B --> C[Observe Behavior]',
      '  C --> D[Measure]',
      '  I --> C',
      '[/MERMAID]',
      '',
      'That is the loop. Done.',
    ].join('\n');
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const code = (blocks[0] as { kind: 'mermaid'; code: string }).code;
    expect(code).toContain('graph TD');
    expect(code).toContain('I --> C');
    expect(code).not.toContain('Here is the flow');
    expect(code).not.toContain('Done.');
    expect(text).toContain('\uE000{mermaid:0}\uE000');
    expect(text).toContain('The loop:');
    expect(text).toContain('That is the loop. Done.');
  });

  it('ignores a `[MERMAID]` inline-code mention before the real block', () => {
    const answer =
      'Use a `[MERMAID]` block:\n[MERMAID]\ngraph LR\n  X-->Y\n[/MERMAID]\nTrailing text.';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const code = (blocks[0] as { kind: 'mermaid'; code: string }).code;
    expect(code).toContain('graph LR');
    expect(code).not.toContain('Use a');
    expect(text).toContain('Trailing text.');
  });
});

describe('resolveUiMarkers — inline segments', () => {
  it('round-trips markers into ordered segments + plain text', () => {
    const raw =
      'Intro line.\n[UI]\n{"t":"card","title":"Panel","children":[{"t":"button","label":"Save","action":"send","prompt":"save it"}]}\n[/UI]\n\nOutro line.';
    const { text, blocks } = extractUiBlocks(raw);
    const { segments, plainText } = resolveUiMarkers(text, blocks);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: 'text', text: 'Intro line.' });
    expect(segments[1].kind).toBe('ui');
    expect(segments[2]).toEqual({ kind: 'text', text: 'Outro line.' });
    expect(plainText).toBe('Intro line.\nOutro line.');
  });

  it('handles a marker at the very start (no leading text)', () => {
    const raw = '[MERMAID]\ngraph TD\n  A --> B\n[/MERMAID]\nDone.';
    const { text, blocks } = extractUiBlocks(raw);
    const { segments, plainText } = resolveUiMarkers(text, blocks);
    expect(segments).toHaveLength(2);
    expect(segments[0].kind).toBe('mermaid');
    expect(plainText).toBe('Done.');
  });

  it('returns segments:[] and unchanged text when there are no markers', () => {
    const { segments, plainText } = resolveUiMarkers('plain answer', []);
    expect(segments).toHaveLength(0);
    expect(plainText).toBe('plain answer');
  });

  it('survives the reply-payload pipeline (markers inside [REPLY])', () => {
    const raw = '[REPLY]\nBody.\n[UI]\n{"t":"button","label":"Ok","action":"send","prompt":"ok"}\n[/UI]\n[/REPLY]';
    const { text, blocks } = extractUiBlocks(raw);
    const replyMatch = text.match(/\[REPLY\][\s\S]*?\[\/REPLY\]/i);
    expect(replyMatch).not.toBeNull();
    expect(replyMatch![0]).toContain('\uE000{ui:0}\uE000');
    expect(blocks).toHaveLength(1);
  });
});

describe('extractUiBlocks — [DIAGRAM] blocks', () => {
  const DIAGRAM = `[DIAGRAM]
%% Release pipeline
<div class="dg-flow">
  <div class="dg-box dg-accent">Build</div>
  <div class="dg-arrow"></div>
  <div class="dg-box">Ship</div>
</div>
[/DIAGRAM]`;

  it('parses a diagram and removes the %% title from the payload', () => {
    const { text, blocks } = extractUiBlocks(`Intro:\n${DIAGRAM}`);
    expect(blocks).toHaveLength(1);
    const d = blocks[0] as { kind: 'diagram'; title: string; html: string };
    expect(d.kind).toBe('diagram');
    expect(d.title).toBe('Release pipeline');
    expect(d.html).toContain('dg-flow');
    expect(d.html).not.toContain('%%');
    expect(text).toContain('\uE000{diagram:0}\uE000');
    expect(text).not.toContain('[DIAGRAM]');
  });

  it('accepts a `%% title:`-prefixed title line', () => {
    const answer = '[DIAGRAM]\n%% title: Deploy flow\n<div class="dg-flow"><div class="dg-box">A</div></div>\n[/DIAGRAM]';
    const { blocks } = extractUiBlocks(answer);
    const d = blocks[0] as { kind: 'diagram'; title: string };
    expect(d.title).toBe('Deploy flow');
  });

  it('converts a standalone ```diagram code fence to tags', () => {
    const answer = '```diagram\n%% Fence flow\n<div class="dg-box">x</div>\n```';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('diagram');
    expect(text).toContain('\uE000{diagram:0}\uE000');
  });

  it('does not mangle a plain ```html fence (bare fences are left alone)', () => {
    const answer = '```html\n<div class="dg-box">raw</div>\n```';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(0);
    expect(text).toContain('```html');
  });

  it('sanitizes hostile markup inside the block', () => {
    const answer =
      '[DIAGRAM]\n%% Safe\n<script>evil()</script><div class="dg-box" style="x:y" onclick="hax()">ok</div><img src="https://evil.example/x" onerror="hax()">\n[/DIAGRAM]';
    const { blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(1);
    const d = blocks[0] as { kind: 'diagram'; html: string };
    expect(d.html).not.toContain('script');
    expect(d.html).not.toContain('onclick');
    expect(d.html).not.toContain('style=');
    expect(d.html).not.toContain('img');
    expect(d.html).toContain('ok');
  });

  it('drops an unclosed diagram whose content does not survive sanitizing', () => {
    const answer = '[DIAGRAM]\n<script>evil()</script>';
    const { text, blocks } = extractUiBlocks(answer);
    expect(blocks).toHaveLength(0);
    expect(text).not.toContain('script');
  });

  it('round-trips a diagram marker into a segment', () => {
    const { text, blocks } = extractUiBlocks(`Lead.\n${DIAGRAM}\nTail.`);
    const { segments, plainText } = resolveUiMarkers(text, blocks);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: 'text', text: 'Lead.' });
    expect((segments[1] as { kind: 'diagram'; title: string }).kind).toBe('diagram');
    expect((segments[1] as { kind: 'diagram'; title: string }).title).toBe('Release pipeline');
    expect(segments[2]).toEqual({ kind: 'text', text: 'Tail.' });
    expect(plainText).toBe('Lead.\nTail.');
  });
});
