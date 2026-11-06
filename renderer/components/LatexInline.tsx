import { Fragment, useMemo } from 'react';
import katex from 'katex';
import { normalizeLatexDelimiters } from './Markdown';

// Renders `$...$` / `$$...$$` (and `\(...\)` / `\[...\]`) LaTeX found inside a
// plain string — the same math the Markdown answer path renders, but for text
// surfaces that display raw strings (CustomUi cards, reasoning panel, hints).
// Falls back to the raw segment when KaTeX can't render a piece.

const DLR = '\u0000DLR\u0000';

type Segment = { math: boolean; body: string; display: boolean };

export function splitLatex(text: string): Segment[] {
  if (!text || (!text.includes('$') && !/\\[\[\(]/.test(text))) {
    return [{ math: false, body: text, display: false }];
  }
  const normalized = normalizeLatexDelimiters(text);
  const protectedText = normalized.replace(/\\\$/g, DLR);
  const segments: Segment[] = [];
  let cursor = 0;
  const re = /(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(protectedText)) !== null) {
    if (m.index > cursor) {
      segments.push({ math: false, body: protectedText.slice(cursor, m.index).replaceAll(DLR, '$'), display: false });
    }
    const seg = m[1];
    const display = seg.startsWith('$$') && seg.endsWith('$$');
    const body = display ? seg.slice(2, -2) : seg.slice(1, -1);
    const trimmed = body.trim();
    // A `$` immediately followed by whitespace + a digit is a price, not math —
    // "costs $ 10 each" would otherwise mis-split. Padding inside `$  x  $` stays math.
    const math = (display || body.includes('\n') || !/^\s*\d/.test(body)) && !(display && body.trim() === '');
    segments.push(
      math
        ? { math: true, body: trimmed, display }
        : { math: false, body: seg.replaceAll(DLR, '$'), display: false },
    );
    cursor = m.index + seg.length;
  }
  if (cursor < protectedText.length) {
    segments.push({ math: false, body: protectedText.slice(cursor).replaceAll(DLR, '$'), display: false });
  }
  return segments;
}

function MathPiece({ body, display }: { body: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      if (body.length > 4000) return '';
      return katex.renderToString(body, { throwOnError: false, displayMode: display, strict: false });
    } catch {
      return '';
    }
  }, [body, display]);
  if (!html) {
    const raw = display ? `$$${body}$ $` : `$${body}$`;
    return <code className="rounded bg-white/12 px-1 py-[1px] font-mono text-[12px] text-white/92 dark:bg-neutral-900/12 dark:text-neutral-900/92">{raw}</code>;
  }
  if (display) {
    return (
      <span
        className="spirit-latex-block-wrap block"
        dangerouslySetInnerHTML={{ __html: html }}
        style={{ margin: '2px 0' }}
      />
    );
  }
  return <span className="spirit-latex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function LatexInline({ text, display = false }: { text: string; display?: boolean }) {
  const segments = useMemo(() => splitLatex(text ?? ''), [text]);
  return (
    <Fragment>
      {segments.map((s, i) =>
        s.math ? (
          <MathPiece key={i} body={s.body} display={display || s.display} />
        ) : (
          <Fragment key={i}>{s.body}</Fragment>
        ),
      )}
    </Fragment>
  );
}