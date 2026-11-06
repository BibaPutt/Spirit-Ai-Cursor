import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerBlock } from '../../lib/spirit';

function Kpis({ items }: { items: Extract<AnswerBlock, { type: 'kpis' }>['items'] }) {
  return (
    <div className="sbox-kpis">
      {items.map((k) => (
        <div className="sbox-kpi" key={k.label}>
          <div className="sbox-kpi__k">{k.label}</div>
          <div className="sbox-kpi__v">{k.value}</div>
          {k.delta ? <div className="sbox-kpi__d">{k.delta}</div> : null}
        </div>
      ))}
    </div>
  );
}

function Chart({ block }: { block: Extract<AnswerBlock, { type: 'chart' }> }) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setInView(true), 40);
    return () => window.clearTimeout(t);
  }, []);
  const max = Math.max(...block.rows.map((r) => r.value), 1);
  return (
    <div className={`sbox-chart${inView ? ' is-in' : ''}`}>
      {block.title && (
        <div className="sbox-chart__title">
          <span>{block.title}</span>
        </div>
      )}
      {block.rows.map((r) => (
        <div className={`sbox-chart__row${r.hi ? ' is-hi' : ''}`} key={r.label}>
          <span className="sbox-chart__label">{r.label}</span>
          <span className="sbox-chart__track">
            <span className="sbox-chart__bar" style={{ '--bar': `${Math.max(8, (r.value / max) * 100)}%` } as React.CSSProperties} />
          </span>
          <span className="sbox-chart__value">{r.display}</span>
        </div>
      ))}
    </div>
  );
}

function Latex({ tex }: { tex: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import('katex')
      .then((katex) => {
        if (!alive) return;
        try {
          setHtml(katex.renderToString(tex, { displayMode: true, throwOnError: false }));
        } catch {
          setFailed(true);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [tex]);
  if (failed) return <div className="sbox-latex"><pre>{tex}</pre></div>;
  if (html === null) return <div className="sbox-latex"><pre>{tex}</pre></div>;
  return <div className="sbox-latex" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import('mermaid')
      .then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
        const id = `sbox-mmd-${Math.random().toString(36).slice(2, 9)}`;
        return mermaid.render(id, code);
      })
      .then(({ svg: out }) => {
        if (alive) setSvg(out);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [code]);
  if (failed || svg === null) return <div className="sbox-mermaid"><pre>{code}</pre></div>;
  return <div className="sbox-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Acts({ items }: { items: Extract<AnswerBlock, { type: 'acts' }>['items'] }) {
  const [doneCount, setDoneCount] = useState(0);
  useEffect(() => {
    setDoneCount(0);
    const timers: number[] = [];
    items.forEach((_, i) => {
      timers.push(window.setTimeout(() => setDoneCount(i + 1), 450 * (i + 1)));
    });
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [items]);
  return (
    <div className="sbox-acts">
      {items.map((a, i) => (
        <span className={`sbox-act${i < doneCount ? ' is-done' : ''}`} key={a.label}>
          <i aria-hidden="true" />
          {a.label}
        </span>
      ))}
    </div>
  );
}

export default function AnswerBlocks({ blocks }: { blocks: AnswerBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="sbox-md">
      {blocks.map((b, i) => {
        const key = `${b.type}-${i}`;
        switch (b.type) {
          case 'p':
            return <p key={key}>{b.text}</p>;
          case 'kpis':
            return <Kpis key={key} items={b.items} />;
          case 'chart':
            return <Chart key={key} block={b} />;
          case 'note':
            return (
              <div className="sbox-note" key={key}>
                {b.text}
              </div>
            );
          case 'annot':
            return (
              <div className="sbox-annot" key={key}>
                <span className="sbox-annot__n">{b.n}</span>
                <span>{b.text}</span>
              </div>
            );
          case 'latex':
            return <Latex key={key} tex={b.tex} />;
          case 'mermaid':
            return <Mermaid key={key} code={b.code} />;
          case 'acts':
            return <Acts key={key} items={b.items} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

export function AnswerSlot({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`sbox__answer${open ? '' : ''}`}>
      <div className="sbox__answer-in">
        <div className="sbox__answer-pad">{children}</div>
      </div>
    </div>
  );
}