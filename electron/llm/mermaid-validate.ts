// Pure, renderer-free Mermaid safety net: extract every [MERMAID]…[/MERMAID]
// block from a candidate answer and structurally validate it BEFORE it ships
// to the client (which renders with a browser-side mermaid). The renderer and
// save template already sanitize, but a grossly broken block (no diagram type,
// unbalanced brackets, bare code fence) fails the whole diagram. This module
// flags those so the router can run one corrective regen round instead of
// shipping a dead widget. Also exports the sanitized form so a "close but
// messy" diagram gets normalized before it is embedded anywhere.

import { sanitizeMermaidCode } from './mermaid-clean';

const DIRECTIVE_RE =
  /^\s*(?:graph|flowchart|sequenceDiagram|sequence-diagram|stateDiagram-v2|stateDiagram|classDiagram-v2|classDiagram|erDiagram|journey|gantt|pie|timeline|quadrantChart|architecture-beta|mindmap|gitGraph|C4Context|requirementDiagram|packet-beta|block-beta|info|sankey-beta|zenuml|kanban|radar|xychart-beta)\b/m;

export type MermaidValidation = { ok: boolean; reason?: string; sanitized: string };

export function extractMermaidCode(text: string): string[] {
  const out: string[] = [];
  const re = /\[MERMAID\]([\s\S]*?)\[\/MERMAID\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

// Quote + comment aware quote/[]/() balancer. Mermaid labels become
// "quoted" after sanitizeMermaidCode, so any surviving balance problem is a
// real structural break, not an escaped label. erDiagram's crow's-foot "{" /
// "}" (CAR ||--o{ TRIP) and classDiagram shape braces are intentionally NOT
// counted — they are legal syntax, not delimiters.
function structuralIssue(code: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[' };
  let quoteCount = 0;
  let inQuote = false;
  let inComment = false;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (inComment) {
      if (ch === '\n') inComment = false;
      i++;
      continue;
    }
    if (ch === '%' && code[i + 1] === '%') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      quoteCount++;
      i++;
      continue;
    }
    if (inQuote) {
      i++;
      continue;
    }
    if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === ']') {
      if (stack.pop() !== pairs[ch]) return true;
    }
    i++;
  }
  if (inQuote) return true;
  if (quoteCount % 2 !== 0) return true;
  return stack.length > 0;
}

export function validateMermaidCode(code: string): MermaidValidation {
  const sanitized = sanitizeMermaidCode(code);
  const trimmed = sanitized.trim();
  const reasons: string[] = [];
  if (!trimmed) reasons.push('diagram is empty');
  if (trimmed.includes('```')) reasons.push('contains a triple-backtick code fence');
  if (!DIRECTIVE_RE.test(trimmed)) {
    reasons.push('missing a diagram-type directive (graph/flowchart/sequenceDiagram/…)');
  }
  if (structuralIssue(trimmed)) reasons.push('unbalanced brackets, parens or quotes');
  if (reasons.length === 0) return { ok: true, sanitized };
  return { ok: false, reason: reasons.join('; '), sanitized };
}