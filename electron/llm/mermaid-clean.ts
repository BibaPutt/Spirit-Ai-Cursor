// Pure (no-electron, no-React) Mermaid cleanup shared by BOTH the renderer
// (renderer/components/MermaidDiagram.tsx, applied before every mermaid.render)
// and the save template (electron/save/template.ts, applied to [MERMAID] blocks
// before they are embedded in saved documents). Regex-only, keeps models'
// sloppy Mermaid output parseable.

import { latexToUnicodeText } from './latex-text';

// Weak local models love injecting hardcoded hex colors as mermaid directives
// ("style A fill:#f9f,stroke:#333", "classDef X ...", "linkStyle 0 ...").
// Those clash with the app theme and are the "all black / wrong colours" look
// the user flagged. Strip them so themeVariables always win — they are purely
// cosmetic; the diagram structure is untouched.
export function stripMermaidColorDirectives(code: string): string {
  return code.replace(/^\s*(?:style|classDef|linkStyle)\b.*$/gm, '');
}

// A diagram directive names the diagram TYPE — "graph TD", "flowchart LR",
// "sequenceDiagram", "gantt", "pie", "journey", etc. Weak models sometimes
// emit the whole flowchart body but SKIP this first line, leaving mermaid
// unable to detect any diagram type ("No diagram type detected ..."). When
// the body still looks like a graph (nodes + edges) we default it to a plain
// top-down flowchart. Anchored per-line (`m`) so a "%% title" comment above
// the real directive can't confuse the check. No `/g`: `.test` on a stateful
// RegExp would skip matches.
const MERMAID_DIRECTIVE_RE = /^\s*(?:graph|flowchart|sequenceDiagram|sequence-diagram|stateDiagram-v2|stateDiagram|classDiagram-v2|classDiagram|erDiagram|journey|gantt|pie|timeline|quadrantChart|architecture-beta|mindmap|gitGraph|C4Context|requirementDiagram|packet-beta|block-beta|info|sankey-beta|zenuml|kanban|radar|xychart-beta)\b/m;

function ensureDiagramHeader(s: string): string {
  if (MERMAID_DIRECTIVE_RE.test(s)) return s;
  return /(?:-->|---|==>|--\||->)/.test(s) ? `graph TD\n${s}` : s;
}

// Remove stray `end` tokens that don't close a `subgraph` (see sanitizeMermaidCode).
// Quote-aware scan so "end" as a WORD inside an already-quoted label or edge text
// is never touched; an `end` directly followed by "["/"("/"{" is a node reference
// ("end[X]"), not a stray closer. Only [ \t] and one adjacent ';'/',' are swallowed
// around a removed token — newlines are preserved so lines never merge with a
// "%% comment". Must run AFTER every label-quoting step so surviving bare `end`
// words are truly stray closers.
export function stripStrayEnds(code: string): string {
  const cuts: { start: number; end: number }[] = [];
  let open = 0;
  let inQuote = false;
  let tokenStart = -1;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(ch)) {
      if (tokenStart === -1) tokenStart = i;
      i++;
      continue;
    }
    if (tokenStart !== -1) {
      const word = code.slice(tokenStart, i);
      if (word === 'subgraph') open++;
      else if (word === 'end' && open > 0) open--;
      else if (word === 'end' && !/[\[({]/.test(code[i] ?? '')) {
        cuts.push({ start: tokenStart, end: i });
      }
      tokenStart = -1;
    }
    i++;
  }
  if (tokenStart !== -1) {
    const word = code.slice(tokenStart, n);
    if (word === 'subgraph') open++;
    else if (word === 'end' && open > 0) open--;
    else if (word === 'end') cuts.push({ start: tokenStart, end: n });
  }
  if (!cuts.length) return code;
  let out = code;
  for (let k = cuts.length - 1; k >= 0; k--) {
    const c = cuts[k];
    let e = c.end;
    while (e < out.length && /[ \t]/.test(out[e])) e++;
    if (e < out.length && /[;,]/.test(out[e])) {
      e++;
      while (e < out.length && /[ \t]/.test(out[e])) e++;
    }
    let b = c.start;
    while (b > 0 && /[ \t]/.test(out[b - 1])) b--;
    if (b > 0 && /[;,]/.test(out[b - 1])) b--;
    out = out.slice(0, b) + out.slice(e);
  }
  return out;
}

// Fix common LLM mistakes in Mermaid syntax before rendering.
export function sanitizeMermaidCode(code: string): string {
  let s = stripMermaidColorDirectives(code);
  // LaTeX → Unicode FIRST: a label like A["\alpha \neq 0"] would otherwise
  // ship backslashes/braces straight into mermaid (and outlive every quoting
  // pass below). Rendering math to characters keeps node/edge labels parseable
  // and readable everywhere — live diagrams, chips, and saved documents.
  s = latexToUnicodeText(s);
  // Node/edge glue: the model joins several statements on one line with ';'
  // or ':' right before the NEXT edge ("D --> E[...]; E--> F(...)"). Split so
  // each edge lands on its own line.
  s = s.replace(/;\s*(?=[A-Za-z0-9_][\w-]*\s*(?:-->|---|==>|--\||->))/g, ';\n');
  s = s.replace(/:\s+(?=[A-Za-z0-9_][\w-]*\s*(?:-->|---|==>|--\||->))/g, ':\n');
  // Repair labels opened with '[' but closed with ')': "E[ Cloud Formation)"
  // → E["Cloud Formation"] (the label-quoting step below would otherwise have
  // nothing to quote and the unclosed bracket breaks the whole diagram).
  //
  // Safe form: the content must contain NO parens (paren labels are legal and
  // common — "A[Rain (mm)]" — and a greedy content run would swallow their
  // closing ")" and double up the final "]" into an unparseable mess), and the
  // closing ")" must not be followed by "]", a quote, or a word char, so a
  // REAL bracket-closed label is never touched.
  s = s.replace(/([A-Za-z0-9_-]+)\[([^\]\n()]*)\)(?![\]"'\w])/g, '$1["$2"]');
  // Strip trailing semicolons from graph directives: "graph TD;" → "graph TD"
  s = s.replace(/^(graph\s+\w+)\s*;\s*$/gm, '$1');
  // Fix unquoted subgraph titles: subgraph SR Consequences → subgraph "SR Consequences"
  s = s.replace(/^(subgraph\s+)(?!")([^\n"]+)(?!")/gm, '$1"$2"');
  // Fix "A & B --> ..." (LLM multi-node shorthand) into separate arrows
  s = s.replace(/^(\s*)(\w+)\s*&\s*(\w+)\s*(-->.+)$/gm, (_, indent: string, a: string, b: string, rest: string) =>
    `${indent}${a} ${rest}\n${indent}${b} ${rest}`,
  );
  // Fix garbled node IDs with spaces: "Long Garbled Text[Label]" → node_N["Label"]
  // In valid Mermaid, node IDs are simple identifiers (no spaces). Weak models
  // sometimes emit the full label as the ID too, creating space-containing IDs.
  // CRITICAL: whitespace joins use [ \t]+ (single horizontal spaces, no
  // newlines) so the chain can never cross lines and eat a "%% title" comment,
  // the "graph TD" directive, or the indented node above the target label —
  // that produced output like `%% title: node_1["..."] --> B{...}` and killed
  // the diagram header.
  let nodeCounter = 0;
  s = s.replace(
    /([a-zA-Z0-9_-]+(?:[ \t]+(?!-->|---|\|)[a-zA-Z0-9_-]+)+)[ \t]*\[([^\]]*)\]/g,
    (_match: string, preceding: string, label: string) => {
      // Only fix if preceding text has spaces AND doesn't start with a keyword
      if (
        preceding.includes(' ') &&
        !/^(?:subgraph|end|click|style|classDef|linkStyle)\b/.test(preceding)
      ) {
        return `node_${++nodeCounter}["${label.replace(/"/g, "'")}"]`;
      }
      return _match;
    },
  );
  // ALWAYS quote unquoted node labels: ID[Content] → ID["Content"]
  // This prevents ANY special char (parens, &, /, :, brackets, etc.) from
  // breaking the Mermaid parser. Already-quoted labels are skipped.
  s = s.replace(
    /(\w+)\[((?!")[^\]]*)\]/g,
    (_match: string, id: string, inner: string) => {
      return `${id}["${inner.replace(/"/g, "'")}"]`;
    },
  );
  // ALWAYS quote unquoted hexagon {"..."} node labels: ID{Content} → ID{"Content"}
  // Same rationale as [] above — '{Apply Aggregation (Daily/Hourly)}' would
  // otherwise stop the parser on the parens ('got PS').
  s = s.replace(
    /(\w+)\{((?!")[^}\n]*)\}/g,
    (_match: string, id: string, inner: string) => {
      return `${id}{"${inner.replace(/"/g, "'")}"}`;
    },
  );
  // ALWAYS quote unquoted edge labels: -->|Content| --> -->|"Content"|
  s = s.replace(
    /(-->\|)(?!")([^\|"]+)(\|)/g,
    (_match: string, pre: string, inner: string, post: string) => {
      return `${pre}"${inner.replace(/"/g, "'")}"${post}`;
    },
  );
  // Remove stray `end` tokens that close nothing. Weak models love closing a
  // plain flowchart with a bare "end", and Mermaid only accepts `end` as a
  // `subgraph` closer — one stray token fails the ENTIRE diagram ("got 'end'").
  s = stripStrayEnds(s);
  // Replace LaTeX \neq with Unicode ≠
  s = s.replace(/\\neq/g, '≠');
  // Replace LaTeX \leq with Unicode ≤
  s = s.replace(/\\leq/g, '≤');
  // Replace LaTeX \geq with Unicode ≥
  s = s.replace(/\\geq/g, '≥');
  // Replace LaTeX \times with Unicode ×
  s = s.replace(/\\times/g, '×');
  // Replace LaTeX \rightarrow with Unicode →
  s = s.replace(/\\rightarrow/g, '→');
  // Replace LaTeX \leftarrow with Unicode ←
  s = s.replace(/\\leftarrow/g, '←');
  // Replace LaTeX \Rightarrow with Unicode ⇒
  s = s.replace(/\\Rightarrow/g, '⇒');
  // Replace LaTeX \Leftarrow with Unicode ⇐
  s = s.replace(/\\Leftarrow/g, '⇐');
  // Last resort for a missing diagram type: if no directive survived but the
  // body still contains edges, default to a top-down flowchart.
  s = ensureDiagramHeader(s);
  return s;
}