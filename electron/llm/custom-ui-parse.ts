// Pure parsing/normalization for the model-emitted UI blocks: [UI], [QUESTIONS],
// [MERMAID] and [DIAGRAM]. This module never touches Electron or the provider
// layer so the vitest suite can exercise it directly (same contract as
// chips-parse).
//
// The blocks are DATA for the UI — the tags and payloads must never reach the
// visible answer. Four block kinds:
//
//   [UI]          a JSON component tree rendered with the app's theme
//   [QUESTIONS]   a JSON question set rendered as a wizard (next/back/skip)
//   [MERMAID]     plain diagram text rendered with Mermaid + "copy as PNG"
//   [DIAGRAM]     hand-authored HTML filled from the .dg-* template vocabulary,
//                 sanitized here and rendered as a themed widget
//
// Weak models are sloppy: they mangle the JSON (semicolons, missing commas,
// unquoted keys, smart quotes), wrap blocks in code fences, forget close tags,
// write stray tags mid-answer, or interleave blocks out of order. The parser
// here is the "doctor": it tries hard to recover a perfect parse, and when a
// block truly cannot be salvaged it is dropped ENTIRELY — raw JSON, raw HTML
// and tag tokens never leak into the answer the user sees.

import type { UiNode, UiQuestion, UiQuestionSet, UiSegment } from '../types';
import { sanitizeDiagramHtml } from './diagram-safe';

export const UI_OPEN = '[UI]';
export const UI_CLOSE = '[/UI]';
export const QUESTIONS_OPEN = '[QUESTIONS]';
export const QUESTIONS_CLOSE = '[/QUESTIONS]';
export const MERMAID_OPEN = '[MERMAID]';
export const MERMAID_CLOSE = '[/MERMAID]';
export const DIAGRAM_OPEN = '[DIAGRAM]';
export const DIAGRAM_CLOSE = '[/DIAGRAM]';
export const OPENUI_OPEN = '[OPENUI]';
export const OPENUI_CLOSE = '[/OPENUI]';

// safety bounds

export const MAX_UI_NODES = 80;
export const MAX_UI_DEPTH = 8;
export const MAX_UI_CHILDREN = 20;
export const MAX_UI_OPTIONS = 12;
export const MAX_STR_TEXT = 4000;
export const MAX_STR_LABEL = 120;
export const MAX_STR_TITLE = 160;
export const MAX_STR_PROMPT = 500;
export const MAX_STR_PLACEHOLDER = 120;
export const MAX_QUESTIONS = 12;
export const MAX_Q_OPTIONS = 12;
export const MAX_Q_TEXT = 300;
export const MAX_MERMAID = 8000;
export const MAX_DIAGRAM = 12000;
export const MAX_OPENUI = 12000;

export type ParsedBlock =
  | { kind: 'ui'; node: UiNode }
  | { kind: 'questions'; questions: UiQuestionSet }
  | { kind: 'mermaid'; code: string }
  | { kind: 'diagram'; title: string; html: string }
  // OpenUI Lang source, rendered by the REAL @openuidev/react-lang Renderer on
  // the renderer side. Kept verbatim (validated structurally here).
  | { kind: 'openui'; code: string };

// Private-use marker substituted for a VALID block so the block survives the
// rest of the answer-cleaning pipeline (web images, next chips, [REPLY],
// "Key takeaways") at its exact position, then resolveUiMarkers turns it back
// into ordered segments. Only valid blocks get markers; invalid ones are
// removed outright.
const markerFor = (kind: string, index: number): string => `\uE000{${kind}:${index}}\uE000`;
const MARKER_RE = /\uE000\{(ui|questions|mermaid|diagram|openui):(\d+)\}\uE000/g;

// Strip screen-annotation tags ([POINT:x,y:label:screenN], [BOX:...], [ARROW:...])
// out of a block's payload. They belong on the visual overlay, never inside a
// [UI] card's JSON string, a wizard question's text, mermaid source, or diagram
// HTML — the tag content has no quotes or braces so removing it can't break JSON.
// The label text before the tag is kept: "Save File [BOX:100,50:320,80:Save File]"
// → "Save File".
export function stripAnnotationTags(s: string): string {
  return s.replace(/\s*\[(?:POINT|BOX|ARROW):[^\]]*\]/g, ' ').trim();
}

// tag scanning

type BlockKind = 'ui' | 'questions' | 'mermaid' | 'diagram' | 'openui';

type Tag = { isOpen: boolean; kind: BlockKind; index: number; end: number };

const TAG_RE = /\[\s*(\/?)\s*(ui|questions|mermaid|diagram|openui)\s*\]/gi;

function findTags(text: string): Tag[] {
  const tags: Tag[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    // Skip tags that are PROSE MENTIONS, not real blocks: "**[MERMAID]**" or
    // "`[MERMAID]`" are the model referencing the block name mid-sentence. If
    // such a tag is mistaken for an open tag it stays UNCLOSED (the real close
    // pairs with the real open), spans to the end of the answer, and swallows
    // the entire tail — the real diagram, chips and takeaways — into one
    // garbage block that mermaid then fails to render ("Could not render
    // diagram").
    const tagEnd = m.index + m[0].length;
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    const after = text.slice(tagEnd, tagEnd + 2);
    const boldWrapped = before === '**' && after === '**';
    const backtickWrapped = m.index > 0 && text[m.index - 1] === '`' && tagEnd < text.length && text[tagEnd] === '`';
    if (boldWrapped || backtickWrapped) continue;
    tags.push({
      isOpen: m[1] !== '/',
      kind: m[2].toLowerCase() as BlockKind,
      index: m.index,
      end: tagEnd,
    });
  }
  return tags;
}

type Span = {
  kind: BlockKind;
  start: number;
  startTagEnd: number;
  end: number;
  endTagStart: number;
  hasClose: boolean;
};

// Match open/close tags with a stack so interleaved or nested blocks never
// get mixed up: each close pairs with the innermost OPEN tag of the same kind,
// and an open that never closes becomes an unclosed span running to the end.
// Stray close tags (no matching open) are left for the purge pass.
function matchSpans(text: string, tags: Tag[]): Span[] {
  const spans: Span[] = [];
  const stack: number[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.isOpen) {
      stack.push(i);
      continue;
    }
    let found = -1;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (tags[stack[s]].kind === tag.kind) {
        found = s;
        break;
      }
    }
    if (found >= 0) {
      const openIdx = stack.splice(found)[0];
      const open = tags[openIdx];
      spans.push({
        kind: open.kind,
        start: open.index,
        startTagEnd: open.end,
        end: tag.end,
        endTagStart: tag.index,
        hasClose: true,
      });
    }
  }
  for (const idx of stack) {
    const open = tags[idx];
    spans.push({
      kind: open.kind,
      start: open.index,
      startTagEnd: open.end,
      end: text.length,
      endTagStart: text.length,
      hasClose: false,
    });
  }
  return spans;
}

// json doctor

function tryJson(s: string): unknown {
  const t = s.trim();
  if (!t) return null;
  if (!/^[{[]/.test(t) || !/[}\]]$/.test(t)) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

// Repair the common failure modes of weak quantized local models before a
// strict parse. Each rewrite is conservative — it only fires on shapes that
// can't appear in valid JSON, so well-formed output is never touched.
function doctorRepairJson(body: string): string {
  let s = body;
  s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  s = s.replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":');
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  s = s.replace(/([\[{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  s = s.replace(/";\s*"/g, '": "');
  s = s.replace(/("\s*)(\r?\n)(\s*)(?=")/g, '$1,$2$3');
  s = s.replace(/}(\s*)(\r?\n)(\s*)(?=\s*\{)/g, '},$2$3');
  s = s.replace(/(")\s+(?="[A-Za-z_][A-Za-z0-9_]*"\s*:)/g, '$1, ');
  s = s.replace(/([{,]\s*)"([Tt])([^"\\]+)"\s*,/g, '$1"$2": "$3",');
  s = s.replace(/,\s*([}\]])/g, '$1');
  s = s.replace(/^\s*\((?=")/gm, '{');
  return s;
}

// Extract the first well-balanced JSON object or array (respecting strings)
// and try to parse it. Salvages a single valid tree out of prose that wraps
// the JSON, or out of a truncated/broken block.
function salvageJson(s: string): unknown[] | null {
  const found: unknown[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      let depth = 0;
      let j = i;
      let inStr = false;
      for (; j < s.length; j++) {
        const c = s[j];
        if (inStr) {
          if (c === '\\') j++;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') {
          inStr = true;
          continue;
        }
        if (c === ch) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0 && j < s.length) {
        const candidate = s.slice(i, j + 1);
        const v = tryJson(candidate) ?? tryJson(doctorRepairJson(candidate));
        if (v !== null) found.push(v);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return found.length > 0 ? found : null;
}

function unwrapFence(inner: string): string {
  let s = inner.trim();
  // Strip code fences: ```json ... ``` or ``` ... ```
  s = s.replace(/^```(?:json|javascript|js|mermaid|html|xml|diagram)?\s*/i, '').replace(/\s*```\s*$/i, '');
  return s.trim();
}

// Strip any non-JSON prefix before the first { or [ (handles bare "json",
// random prose, or any other junk the model prepends before the actual data).
// Only used for JSON-like blocks ([UI], [QUESTIONS]), NOT for mermaid.
function stripNonJsonPrefix(s: string): string {
  const jsonStart = s.search(/[{[]/);
  if (jsonStart > 0) s = s.slice(jsonStart);
  return s.trim();
}

// UI tree normalization

const TYPE_ALIASES: Record<string, string> = {
  card: 'card',
  section: 'section',
  container: 'section',
  row: 'row',
  grid: 'grid',
  tabs: 'tabs',
  heading: 'heading',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  text: 'text',
  label: 'text',
  paragraph: 'text',
  badge: 'badge',
  tag: 'badge',
  pill: 'badge',
  code: 'code',
  list: 'list',
  ul: 'list',
  ol: 'list',
  quote: 'quote',
  link: 'link',
  kv: 'kv',
  'key-value': 'kv',
  table: 'table',
  stat: 'stat',
  steps: 'steps',
  timeline: 'timeline',
  divider: 'divider',
  hr: 'divider',
  progress: 'progress',
  button: 'button',
  btn: 'button',
  toggle: 'toggle',
  switch: 'toggle',
  slider: 'slider',
  range: 'slider',
  select: 'select',
  dropdown: 'select',
  radio: 'radio',
  'radio-group': 'radio',
  checkbox: 'checkbox',
  'text-input': 'text-input',
  input: 'text-input',
  field: 'text-input',
  textarea: 'textarea',
  password: 'password',
  number: 'number',
  date: 'date',
  multiselect: 'multiselect',
  'multi-select': 'multiselect',
  mermaid: 'mermaid',
};

const VALID_VARIANTS = new Set([
  'strong',
  'accent',
  'soft',
  'ghost',
  'neutral',
  'success',
  'warning',
  'danger',
]);

const VALID_ACTIONS = new Set(['send', 'copy', 'reset']);

function str(v: unknown, cap: number): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, cap);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

type Ctx = { nodes: number };

function normalizeOptions(value: unknown): UiNode['options'] {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ label?: string; value?: unknown } | string> = [];
  for (const item of value) {
    if (out.length >= MAX_UI_OPTIONS) break;
    if (typeof item === 'string') {
      if (item.trim()) out.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const label = str(o.label ?? o.text, MAX_STR_LABEL).trim();
      if (!label) continue;
      const val = o.value !== undefined ? o.value : label;
      out.push({ label, value: val });
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeNode(raw: unknown, depth: number, ctx: Ctx): UiNode | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    ctx.nodes++;
    return { t: 'text', text: text.slice(0, MAX_STR_TEXT) };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const tRaw = str(obj.t ?? obj.type ?? obj.tag, 40).toLowerCase().replace(/^ui[-:]/, '');
  const t = TYPE_ALIASES[tRaw];
  if (!t) return null;
  if (ctx.nodes + 1 > MAX_UI_NODES) return null;
  if (depth > MAX_UI_DEPTH) return null;
  ctx.nodes++;

  const node: UiNode = { t };

  const title = str(obj.title, MAX_STR_TITLE).trim();
  const label = str(obj.label, MAX_STR_LABEL).trim();
  const text = str(obj.text, MAX_STR_TEXT).trim();
  const placeholder = str(obj.placeholder, MAX_STR_PLACEHOLDER).trim();

  if (title) node.title = title;
  if (label) node.label = label;
  if (text) node.text = text;
  if (placeholder) node.placeholder = placeholder;

  const icon = str(obj.icon, 40).trim();
  if (icon) node.icon = icon.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);

  const variant = str(obj.variant, 30).toLowerCase();
  if (VALID_VARIANTS.has(variant)) node.variant = variant;

  const name = str(obj.name, 60).trim();
  if (name) node.name = name;

  if (obj.default !== undefined) node.default = obj.default;
  if (obj.required === true) node.required = true;
  if (obj.disabled === true) node.disabled = true;

  const href = str(obj.href, 1000).trim();
  if (href && /^(https?:\/\/|mailto:)/i.test(href)) node.href = href;

  const options = normalizeOptions(obj.options);
  if (options) node.options = options;

  const cols = num(obj.cols);
  if (cols !== undefined && cols >= 1 && cols <= 6) node.cols = cols;
  const min = num(obj.min);
  const max = num(obj.max);
  const step = num(obj.step);
  if (min !== undefined) node.min = min;
  if (max !== undefined) node.max = max;
  if (step !== undefined) node.step = step;

  const delta = str(obj.delta, 40).trim();
  if (delta) node.delta = delta;

  if (Array.isArray(obj.items)) {
    const items: string[] = [];
    for (const it of obj.items) {
      if (items.length >= 12) break;
      if (typeof it === 'string' && it.trim()) items.push(it.trim().slice(0, MAX_STR_TEXT));
    }
    if (items.length > 0) node.items = items;
  }

  if (Array.isArray(obj.headers)) {
    const headers: string[] = [];
    for (const h of obj.headers) {
      if (headers.length >= 8) break;
      if (typeof h === 'string' && h.trim()) headers.push(h.trim().slice(0, MAX_STR_LABEL));
    }
    if (headers.length > 0) node.headers = headers;
  }

  if (Array.isArray(obj.rows)) {
    const rows: Array<Array<string | number>> = [];
    for (const r of obj.rows) {
      if (rows.length >= 30) break;
      if (!Array.isArray(r)) continue;
      const cells: Array<string | number> = [];
      for (const c of r) {
        if (cells.length >= 12) break;
        if (typeof c === 'string' || typeof c === 'number') cells.push(typeof c === 'string' ? c.slice(0, MAX_STR_TEXT) : c);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) node.rows = rows;
  }

  const active = num(obj.active);
  if (active !== undefined) node.active = active;

  const action = str(obj.action, 30).toLowerCase();
  if (VALID_ACTIONS.has(action)) node.action = action;

  const prompt = str(obj.prompt, MAX_STR_PROMPT).trim();
  if (prompt) node.prompt = prompt;

  if (Array.isArray(obj.children)) {
    const children: UiNode[] = [];
    for (const child of obj.children) {
      if (children.length >= MAX_UI_CHILDREN) break;
      const n = normalizeNode(child, depth + 1, ctx);
      if (n) children.push(n);
    }
    if (children.length > 0) node.children = children;
  }

  return node;
}

function normalizeRoot(parsed: unknown): UiNode | null {
  if (Array.isArray(parsed)) {
    const ctx: Ctx = { nodes: 0 };
    const children: UiNode[] = [];
    for (const item of parsed) {
      if (children.length >= MAX_UI_CHILDREN) break;
      const n = normalizeNode(item, 0, ctx);
      if (n) children.push(n);
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { t: 'card', children };
  }
  return normalizeNode(parsed, 0, { nodes: 0 });
}

// HTML-to-UiNode fallback
// Weak models sometimes emit <div> HTML inside [UI] instead of JSON.
// This lightweight converter extracts headings, text, lists, and dividers
// from the common <div class="..." text="..."> pattern the model uses.

function extractHtmlText(html: string): string {
  return html
    .replace(/<div[^>]*>/gi, '')
    .replace(/<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function findNestedDivContent(html: string, cls: string): string | null {
  const openRe = new RegExp(`<div\\s+class="${cls}"[^>]*>`, 'i');
  const openMatch = openRe.exec(html);
  if (!openMatch) return null;
  const start = openMatch.index + openMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return html.slice(start, nextClose);
      i = nextClose + 6;
    }
  }
  return html.slice(start);
}

function htmlDivsToUiNodes(html: string): UiNode[] {
  const nodes: UiNode[] = [];
  const DIV_RE = /<div\s+([^>]*?)>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = DIV_RE.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const clsMatch = /class="([^"]+)"/i.exec(attrs);
    const cls = clsMatch?.[1]?.toLowerCase() ?? '';
    const textAttrMatch = /text="([^"]*?)"/i.exec(attrs);
    const textAttr = textAttrMatch?.[1] ?? '';

    if (cls.includes('heading')) {
      const text = textAttr || extractHtmlText(body);
      if (text.trim()) nodes.push({ t: 'heading', text: text.trim() });
    } else if (cls.includes('divider') || cls === 'hr') {
      nodes.push({ t: 'divider' });
    } else if (cls.includes('list')) {
      const items: string[] = [];
      const LI_RE = /<div\s+class="text"[^>]*>([\s\S]*?)<\/div>/gi;
      let li: RegExpExecArray | null;
      while ((li = LI_RE.exec(body))) {
        const text = extractHtmlText(li[1]);
        if (text.trim()) items.push(text.trim());
      }
      if (items.length === 0) {
        const fallback = extractHtmlText(body);
        if (fallback.trim()) items.push(fallback.trim());
      }
      if (items.length > 0) nodes.push({ t: 'list', items });
    } else if (cls.includes('card') || cls.includes('section')) {
      const inner = findNestedDivContent(html, cls);
      if (inner) {
        const children = htmlDivsToUiNodes(inner);
        if (children.length > 0) {
          const card: UiNode = { t: cls.includes('card') ? 'card' : 'section', children };
          if (textAttr) card.title = textAttr;
          nodes.push(card);
        }
      }
    } else if (cls.includes('text') || cls.includes('paragraph')) {
      const text = textAttr || extractHtmlText(body);
      if (text.trim()) nodes.push({ t: 'text', text: text.trim() });
    } else {
      const text = textAttr || extractHtmlText(body);
      if (text.trim()) nodes.push({ t: 'text', text: text.trim() });
    }
  }
  return nodes;
}

// Doctor-parse a [UI] block's inner text into a validated component tree.
// Tries strict → repaired → salvaged → HTML fallback, in that order; returns
// null only when nothing parses (the caller then drops the block entirely).
function parseUiBlock(inner: string): UiNode | null {
  const body = stripNonJsonPrefix(unwrapFence(inner));
  if (!body) return null;
  let parsed: unknown = tryJson(body);
  let repaired = '';
  if (parsed === null) {
    repaired = doctorRepairJson(body);
    if (repaired !== body) parsed = tryJson(repaired);
  }
  if (parsed === null) {
    const salvaged = salvageJson(repaired !== '' && repaired !== body ? repaired : body);
    if (salvaged !== null) {
      // Pick the LAST valid root — the model usually narrates before the JSON.
      for (const candidate of salvaged) {
        const node = normalizeRoot(candidate);
        if (node) parsed = candidate;
      }
    }
  }
  if (parsed !== null) return normalizeRoot(parsed);

  // Fallback: model emitted HTML instead of JSON — extract structured content.
  if (/<div[\s>]/i.test(body)) {
    const htmlNodes = htmlDivsToUiNodes(body);
    if (htmlNodes.length > 0) {
      if (htmlNodes.length === 1) return htmlNodes[0];
      return { t: 'card', children: htmlNodes };
    }
  }

  return null;
}

// question-set normalization

const VALID_QUESTION_TYPES = new Set([
  'radio',
  'slider',
  'multi',
  'text',
  'textarea',
  'select',
  'checkbox',
  'toggle',
  'number',
  'date',
]);

function normalizeQuestion(raw: unknown): UiQuestion | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const q = str(obj.q ?? obj.question ?? obj.label ?? obj.text, MAX_Q_TEXT).trim();
  if (!q) return null;

  const question: UiQuestion = { q };

  const typeRaw = str(obj.type ?? obj.t, 20).toLowerCase();
  if (VALID_QUESTION_TYPES.has(typeRaw)) question.type = typeRaw as UiQuestion['type'];

  const name = str(obj.name, 60).trim();
  if (name) question.name = name;

  if (obj.default !== undefined) question.default = obj.default;
  if (obj.required === true) question.required = true;

  const placeholder = str(obj.placeholder, MAX_STR_PLACEHOLDER).trim();
  if (placeholder) question.placeholder = placeholder;

  const min = num(obj.min);
  const max = num(obj.max);
  const step = num(obj.step);
  if (min !== undefined) question.min = min;
  if (max !== undefined) question.max = max;
  if (step !== undefined) question.step = step;

  if (Array.isArray(obj.options)) {
    const options: Array<{ label: string; value: string } | string> = [];
    for (const item of obj.options) {
      if (options.length >= MAX_Q_OPTIONS) break;
      if (typeof item === 'string') {
        if (item.trim()) options.push(item);
        continue;
      }
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const label = str(o.label ?? o.value, MAX_STR_LABEL).trim();
        if (!label) continue;
        const value = str(o.value ?? label, MAX_STR_LABEL).trim();
        options.push({ label, value: value || label });
      }
    }
    if (options.length > 0) question.options = options;
  }

  return question;
}

function parseQuestionsBlock(inner: string): UiQuestionSet | null {
  const body = stripNonJsonPrefix(unwrapFence(inner));
  if (!body) return null;
  let parsed: unknown = tryJson(body);
  if (parsed === null) {
    const repaired = doctorRepairJson(body);
    if (repaired !== body) parsed = tryJson(repaired);
  }
  if (parsed === null) {
    const salvaged = salvageJson(body);
    if (salvaged !== null) parsed = salvaged[salvaged.length - 1];
  }
  if (parsed === null) return null;

  // Accept: { title?, questions: [...] }, an array of questions, or a single
  // question object (wrapped into a one-question set).
  let list: unknown[] | null = null;
  let title = '';
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    title = str(obj.title, MAX_STR_TITLE).trim();
    if (Array.isArray(obj.questions)) list = obj.questions;
    else if (Array.isArray(obj.items)) list = obj.items;
    else list = [obj];
  }
  if (!list) return null;

  const questions: UiQuestion[] = [];
  for (const item of list) {
    if (questions.length >= MAX_QUESTIONS) break;
    const q = normalizeQuestion(item);
    if (q) questions.push(q);
  }
  if (questions.length === 0) return null;
  const set: UiQuestionSet = { questions };
  if (title) set.title = title;
  return set;
}

// mermaid

function parseMermaidBlock(inner: string): string | null {
  const body = unwrapFence(inner);
  if (!body) return null;
  // A diagram is just text — if it looks like prose (no diagram keyword),
  // still accept it; Mermaid fails gracefully in the renderer. Only bound the
  // size so a runaway block can't bloat the answer.
  return body.length <= MAX_MERMAID ? body : null;
}

// diagram

function parseDiagramBlock(inner: string): { title: string; html: string } | null {
  const body = unwrapFence(inner).slice(0, MAX_DIAGRAM);
  if (!body) return null;
  let html = body;
  // The block carries its title on the very first `%%` line (same convention
  // as [MERMAID]); it is consumed by the parser and stripped from the payload.
  let title = '';
  const titleLine = html.match(/^%%[^\n]*$/m);
  if (titleLine) {
    title = titleLine[0].slice(2).trim().replace(/^title:\s*/i, '').trim();
    html = html.replace(/^%%[^\n]*\n?/m, '');
  }
  // The auto-close repair (extractUiBlocks) may append the close tag as text;
  // never let that literal tag become diagram content.
  const clean = sanitizeDiagramHtml(html.replace(/\[\s*\/\s*diagram\s*\]/gi, ''));
  if (!clean) return null;
  return { title, html: clean };
}

// extraction

// OpenUI Lang is plain text (`root = Card([...])`), not JSON — no repair needed.
// Structural validation only: the renderer's real OpenUI parser is the
// authority on syntax, and it degrades gracefully (meta.errors) rather than
// throwing. Reject empty/payload-less blocks so the tag never leaks as text.
function parseOpenUiBlock(inner: string): string | null {
  const body = unwrapFence(inner).trim();
  if (!body || body.length > MAX_OPENUI) return null;
  if (!/^[ \t]*[A-Za-z_][A-Za-z0-9_]*\s*=\s*[A-Z][A-Za-z0-9_]*\s*\(/m.test(body)) return null;
  return body;
}

function parseSpanInner(kind: BlockKind, inner: string): ParsedBlock | null {
  if (kind === 'openui') {
    const code = parseOpenUiBlock(inner);
    return code ? { kind, code } : null;
  }
  if (kind === 'diagram') {
    const d = parseDiagramBlock(inner);
    return d ? { kind, title: d.title, html: d.html } : null;
  }
  if (kind === 'mermaid') {
    const code = parseMermaidBlock(inner);
    return code ? { kind, code } : null;
  }
  if (kind === 'questions') {
    const questions = parseQuestionsBlock(inner);
    return questions ? { kind, questions } : null;
  }
  const node = parseUiBlock(inner);
  return node ? { kind, node } : null;
}

// Convert standalone ```mermaid / ```diagram code fences into [MERMAID] /
// [DIAGRAM] tags so extractUiBlocks picks them up. Weak models often emit code
// fences instead of the requested tag format.
function convertCodeFencedMermaid(text: string): string {
  // Match ```mermaid (optionally indented) ... ``` on its own line(s).
  // Only convert fences explicitly tagged as mermaid/diagram — bare ```
  // fences are left alone (they might be JS, JSON, etc.). The closing fence
  // uses a flexible indent (not a backreference) because .trim() may strip
  // leading spaces from the opening fence while the closing fence keeps its
  // original indentation.
  return text.replace(
    /^([ \t]*)(```)(mermaid|diagram|openui|openui-lang)\s*\n([\s\S]*?)\n[ \t]*```\s*$/gm,
    (_m: string, indent: string, _open: string, tag: string, body: string) => {
      const t = tag.toLowerCase();
      const open = t === 'diagram' ? DIAGRAM_OPEN
        : t === 'mermaid' ? MERMAID_OPEN
        : OPENUI_OPEN;
      const close = t === 'diagram' ? DIAGRAM_CLOSE
        : t === 'mermaid' ? MERMAID_CLOSE
        : OPENUI_CLOSE;
      return `${indent}${open}\n${body}\n${indent}${close}`;
    },
  );
}

// Extract every valid [UI] / [QUESTIONS] / [MERMAID] / [DIAGRAM] block from a
// raw answer. Returns the answer text with valid blocks replaced by
// private-use markers and invalid/unsalvageable blocks removed outright, plus
// the parsed blocks.
// Markers flow through the rest of the cleaning pipeline (web images, next
// chips, [REPLY], "Key takeaways") and resolveUiMarkers turns them into
// inline segments at the end.
export function extractUiBlocks(answer: string): { text: string; blocks: ParsedBlock[] } {
  const text = convertCodeFencedMermaid((answer ?? '').trim());
  if (!text) return { text, blocks: [] };

  const tags = findTags(text);
  if (tags.length === 0) return { text, blocks: [] };

  const spans = matchSpans(text, tags);
  if (spans.length === 0) return { text, blocks: [] };

  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const blocks: ParsedBlock[] = [];
  const replacements: Array<{ start: number; end: number; marker: string }> = [];
  let coveredUntil = -1;

  for (const span of spans) {
    if (span.start < coveredUntil) continue; // nested inside an outer block
    const inner = stripAnnotationTags(text.slice(span.startTagEnd, span.endTagStart));
    let parsed = parseSpanInner(span.kind, inner);

    // Auto-close: if parsing failed on an unclosed block, try appending the
    // close tag. This handles truncated model output where the token limit
    // was hit mid-generation — the content is valid, just missing the close.
    if (!parsed && !span.hasClose) {
      const fullContent = stripAnnotationTags(text.slice(span.startTagEnd, span.end));
      const closeTag = span.kind === 'ui' ? UI_CLOSE
        : span.kind === 'questions' ? QUESTIONS_CLOSE
        : span.kind === 'mermaid' ? MERMAID_CLOSE
        : span.kind === 'openui' ? OPENUI_CLOSE
        : DIAGRAM_CLOSE;
      parsed = parseSpanInner(span.kind, fullContent + closeTag);
    }

    if (parsed) {
      const index = blocks.length;
      blocks.push(parsed);
      replacements.push({ start: span.start, end: span.end, marker: markerFor(span.kind, index) });
    } else if (span.hasClose) {
      // Unsalvageable block with both tags — drop the whole thing.
      replacements.push({ start: span.start, end: span.end, marker: '' });
    } else {
      // Unclosed tag that didn't parse even with auto-close — drop the entire
      // span (open tag + content) so raw HTML/JSON never leaks into the answer.
      replacements.push({ start: span.start, end: span.end, marker: '' });
    }
    coveredUntil = span.end;
  }

  // Apply replacements from the END so earlier indices stay valid.
  replacements.sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.marker + out.slice(r.end);
  }

  // Purge any leftover tag tokens (stray close tags, tag lines outside a
  // complete block, mid-sentence tags) — tags are UI markers, never text.
  out = out.replace(/\[\s*\/?\s*(ui|questions|mermaid|diagram|openui)\s*\]/gi, '');

  out = out
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: out, blocks };
}

// Turn marker-bearing cleaned text back into ordered inline segments. `text`
// segments render as markdown; ui/questions/mermaid/diagram segments render as
// widgets, all at the marker's exact position. `plainText` is the marker-free
// text — the canonical answer stored in history and read aloud by TTS.
export function resolveUiMarkers(
  text: string,
  blocks: ParsedBlock[],
): { segments: UiSegment[]; plainText: string } {
  const textParts: string[] = [];
  const segments: UiSegment[] = [];

  let last = 0;
  let any = false;
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text))) {
    any = true;
    const before = text.slice(last, m.index).trim();
    if (before) {
      textParts.push(before);
      segments.push({ kind: 'text', text: before });
    }
    const index = Number(m[2]);
    const block = blocks[index];
    if (block) {
      if (block.kind === 'ui') segments.push({ kind: 'ui', block: block.node });
      else if (block.kind === 'questions') segments.push({ kind: 'questions', questions: block.questions });
      else if (block.kind === 'mermaid') segments.push({ kind: 'mermaid', code: block.code });
      else if (block.kind === 'openui') segments.push({ kind: 'openui', code: block.code });
      else segments.push({ kind: 'diagram', title: block.title, html: block.html });
    }
    last = m.index + m[0].length;
  }

  if (!any) return { segments: [], plainText: text };

  const after = text.slice(last).trim();
  if (after) {
    textParts.push(after);
    segments.push({ kind: 'text', text: after });
  }

  return { segments, plainText: textParts.join('\n') };
}
