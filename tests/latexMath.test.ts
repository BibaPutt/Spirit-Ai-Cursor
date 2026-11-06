import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { normalizeLatexDelimiters } from '../renderer/components/Markdown';
import { remarkLatex } from '../renderer/lib/remark-latex';

function markerAst(md: string): Array<{ type: string; value: string }> {
  const out: Array<{ type: string; value: string }> = [];
  unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkLatex)
    .use(remarkGfm)
    .use(() => (tree: any) => {
      const walk = (node: any) => {
        if (node.type === 'html' && (node.value as string).includes('spirit-latex')) {
          out.push({ type: node.type, value: node.value as string });
        }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      };
      walk(tree);
    })
    .use(remarkStringify)
    .processSync(md);
  return out;
}

describe('normalizeLatexDelimiters', () => {
  it('leaves $$ display math untouched', () => {
    const src = 'The sum is\n\n$$\n\\sum_{i=1}^n i\n$$';
    expect(normalizeLatexDelimiters(src)).toBe(src);
  });

  it('converts \\[...\\] display math to $$', () => {
    const out = normalizeLatexDelimiters('Solve:\n\\[\n\\sum_{k=1}^n k^2\n\\]');
    expect(out).toContain('$$');
    expect(out).toContain('\\sum_{k=1}^n k^2');
    expect(out).not.toContain('\\[');
  });

  it('converts \\(...\\) inline math to $', () => {
    const out = normalizeLatexDelimiters('Einstein said \\(E = mc^2\\) once');
    expect(out).toContain('$E = mc^2$');
    expect(out).not.toContain('\\(');
  });

  it('wraps bare \\begin{align} blocks when no other delimiters exist', () => {
    const out = normalizeLatexDelimiters('Compute:\n\\begin{align}\na &= b + c \\\\\nd &= e\n\\end{align}');
    expect(out).toContain('$$');
    expect(out).toContain('\\begin{aligned}');
    expect(out).toContain('\\end{aligned}');
  });

  it('does NOT double-wrap when $ delimiters are already present', () => {
    const out = normalizeLatexDelimiters('Here:\n$$\\begin{aligned}a&=b\\end{aligned}$$');
    expect(out.match(/\$\$/g)).toHaveLength(2);
  });
});

describe('remarkLatex', () => {
  it('converts inlineMath nodes into escaped inline markers', () => {
    const markers = markerAst('Energy is $E = mc^2$ famously');
    expect(markers).toHaveLength(1);
    expect(markers[0].value).toContain('spirit-latex-inline');
    expect(markers[0].value).toContain('>E = mc^2</span>');
  });

  it('converts math nodes into escaped block markers', () => {
    const markers = markerAst('Sum:\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$');
    expect(markers).toHaveLength(1);
    expect(markers[0].value).toContain('spirit-latex-block');
    expect(markers[0].value).toContain('\\sum_{i=1}^n i');
  });

  it('escapes < > & inside LaTeX so it cannot inject HTML', () => {
    const markers = markerAst('$a < b \\& c > d$');
    expect(markers).toHaveLength(1);
    expect(markers[0].value).toContain('&lt;');
    expect(markers[0].value).toContain('&amp;');
    expect(markers[0].value).toContain('&gt;');
  });
});
