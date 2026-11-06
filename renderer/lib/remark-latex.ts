// remarkLatex — turns remark-math's `inlineMath` / `math` nodes into inline
// placeholder <span> markers so react-markdown can hand the raw LaTeX to
// KaTeX at render time (see Latex in Markdown.tsx).
//
// Why markers instead of rehype-katex: the app sanitizes LLM HTML with
// rehype-sanitize, which deliberately strips `style` attributes and foreign
// attrs — KaTeX's pre-rendered HTML relies on both, so it would render broken
// after sanitization. Instead we escape the LaTeX into an inert text span that
// survives sanitization untouched, and KaTeX runs in React with renderToString
// on data that is never treated as markup by the pipeline.
import type { Root } from 'mdast';

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  [key: string]: unknown;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toMarker(node: Node): { type: 'html'; value: string } {
  const display = node.type === 'math';
  const latex = String(node.value ?? '');
  return {
    type: 'html',
    value:
      `<span class="spirit-latex${display ? ' spirit-latex-block' : ' spirit-latex-inline'}">` +
      `${escapeHtml(latex)}</span>`,
  };
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  const children = node.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      walk(children[i], visit);
    }
  }
}

export function remarkLatex() {
  return (tree: Root) => {
    walk(tree as unknown as Node, (node) => {
      if (node.type !== 'inlineMath' && node.type !== 'math') return;
      const marker = toMarker(node);
      for (const key of Object.keys(node)) {
        delete (node as Record<string, unknown>)[key];
      }
      (node as Record<string, unknown>).type = marker.type;
      (node as Record<string, unknown>).value = marker.value;
    });
  };
}
