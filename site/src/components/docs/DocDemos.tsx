import { useEffect, useRef, useState } from 'react';
import SpiritBox from '../spirit/SpiritBox';
import AnnotationFrame from '../spirit/AnnotationFrame';
import { useSpiritSequence, type SpiritAnnotation } from '../../lib/spirit';
import { DOC_ANNOTATE_DEMO, DOC_BOX_DEMO } from '../../data/docdemo';

// Live demos for the docs. No screenshots anywhere: where an image would
// normally sit, the real Spirit UI components render — same sbox/sann/sbox-
// glass classes the landing page ports from the app, so what the docs show
// is literally Spirit. Demos play when the reader scrolls them into view.

function usePlayOnView(play: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) play();
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

export function DocBoxDemo() {
  const seq = useSpiritSequence(DOC_BOX_DEMO, { auto: false, start: false });
  const ref = usePlayOnView(() => seq.run(DOC_BOX_DEMO));
  return (
    <div className="docdemo" data-ui ref={ref}>
      <div className="docdemo__spirit">
        <SpiritBox seq={seq} demo={DOC_BOX_DEMO} phase={seq.phase} staticCursor />
      </div>
    </div>
  );
}

export function DocAnnotateDemo() {
  const [anns, setAnns] = useState<SpiritAnnotation[]>([]);
  const seq = useSpiritSequence(DOC_ANNOTATE_DEMO, {
    auto: false,
    start: false,
    onAnnotation: setAnns,
  });
  const ref = usePlayOnView(() => seq.run(DOC_ANNOTATE_DEMO));
  return (
    <div className="docdemo" data-ui ref={ref}>
      <div className="docdemo__window">
        <div className="docdemo__chrome" aria-hidden="true">
          <span />
          <span />
          <span />
          <span className="docdemo__chrome-title">invoice-042.pdf</span>
        </div>
        <div className="docdemo__sheet">
          <p className="docdemo__row" data-sann-target="docdemo-total">
            <span>Total</span>
            <span>$4,280.00</span>
          </p>
          <p className="docdemo__row is-muted">
            <span>Subtotal</span>
            <span>$4,076.00</span>
          </p>
          <p className="docdemo__row is-muted">
            <span>Tax (5%)</span>
            <span>$203.80</span>
          </p>
          <div className="docdemo__toolbar">
            <span className="docdemo__btn">Print</span>
            <span className="docdemo__btn is-primary" data-sann-target="docdemo-export">
              Export
            </span>
          </div>
        </div>
        <AnnotationFrame annotations={anns} className="docdemo__anns" />
      </div>
    </div>
  );
}

const TOOL_ARG_ROWS: Array<[string, string]> = [
  ['tool', 'run_command'],
  ['command', 'npm run gate'],
  ['cwd', 'SPIRIT-deep/'],
];

export function DocToolsDemo() {
  const [decision, setDecision] = useState<'pending' | 'allowed' | 'denied'>('pending');
  return (
    <div className="docdemo" data-ui>
      <div className="docdemo__approve sbox-glass">
        <div className="docdemo__approve-head">
          <span className="docdemo__approve-dot" aria-hidden="true" />
          Spirit wants to run a command
          <span className="docdemo__approve-tag">HIGH_IMPACT · always asks</span>
        </div>
        <div className="docdemo__approve-args">
          {TOOL_ARG_ROWS.map(([k, v]) => (
            <div className="docdemo__approve-row" key={k}>
              <code>{k}</code>
              <code>{v}</code>
            </div>
          ))}
        </div>
        {decision === 'pending' ? (
          <div className="docdemo__approve-actions">
            <button type="button" className="docdemo__btn is-primary" onClick={() => setDecision('allowed')}>
              Allow once
            </button>
            <button type="button" className="docdemo__btn" onClick={() => setDecision('denied')}>
              Deny
            </button>
          </div>
        ) : (
          <div className="docdemo__approve-status">
            {decision === 'allowed'
              ? 'Approved — the executor runs the tool and feeds the result back to the model.'
              : 'Denied — the model receives the refusal and adapts its answer.'}
          </div>
        )}
      </div>
    </div>
  );
}
