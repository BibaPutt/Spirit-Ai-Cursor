import { useLayoutEffect, useRef, type RefObject } from 'react';
import SpiritBox from './spirit/SpiritBox';
import BibataCursor from './spirit/BibataCursor';
import { DIP_DEMO, EXPORT_DEMO } from '../data/demo';
import { useSpiritSequence } from '../lib/spirit';
import { useI18n } from '../i18n';

function useSpiritAnchor(hostRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const apply = () => {
      const spirit = host.querySelector<HTMLElement>('.fsence__spirit');
      const mock = host.querySelector<HTMLElement>('.mock');
      if (!spirit || !mock) return;
      if (window.innerWidth <= 980) {
        spirit.style.left = '';
        spirit.style.right = '';
        return;
      }
      const hostLeft = host.getBoundingClientRect().left;
      const mockLeft = mock.getBoundingClientRect().left;
      const width = spirit.getBoundingClientRect().width;
      const left = Math.min(mockLeft + 96, window.innerWidth - width - 12);
      spirit.style.left = `${left - hostLeft}px`;
      spirit.style.right = 'auto';
    };
    apply();
    const raf = requestAnimationFrame(apply);
    const timer = window.setTimeout(apply, 300);
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    ro.observe(document.documentElement);
    window.addEventListener('resize', apply);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [hostRef]);
}

function Bar({ file }: { file: string }) {
  return (
    <div className="mock__bar">
      <span className="mock__file">{file}</span>
    </div>
  );
}

const INVOICE_ROWS = [
  { label: 'Design retainer', qty: '1', amount: '$2,400.00' },
  { label: 'Seat add-ons', qty: '5', amount: '$1,480.00' },
  { label: 'Seat add-ons', qty: '2', amount: '$400.00', hit: true },
];

const REVENUE_BARS = [
  { month: 'Jan', value: '$78k', h: 78 },
  { month: 'Feb', value: '$92k', h: 92 },
  { month: 'Mar', value: '$61k', h: 61, hi: true },
  { month: 'Apr', value: '$88k', h: 88 },
];

const PIPELINE_STAGES = [
  { label: 'Lead', count: '1,284', w: 100 },
  { label: 'Qualified', count: '462', w: 64 },
  { label: 'Proposal', count: '118', w: 34 },
  { label: 'Won', count: '37', w: 16 },
];

const PIPELINE_DEALS = [
  { name: 'Northwind', stage: 'Won', value: '$42k' },
  { name: 'Acme', stage: 'Proposal', value: '$18k', hit: true },
  { name: 'Globex', stage: 'Qualified', value: '$9k' },
  { name: 'Initech', stage: 'Lead', value: '$6k' },
];

function ReadStage() {
  const { t } = useI18n();
  return (
    <div className="mock" data-ui>
      <Bar file="invoice-042.pdf" />
      <div className="mock__page">
        <div className="mock__head">
          <span>{t('feature.invoice')}</span>
          <span>#042</span>
        </div>
        <div className="mock__meta">
          <span>Acme Studio</span>
          <span>Due Mar 14</span>
        </div>
        <div className="mock__table">
          <div className="mock__trow mock__trow--head">
            <span>Description</span>
            <span>Qty</span>
            <span>Amount</span>
          </div>
          {INVOICE_ROWS.map((row) => (
            <div className={`mock__trow${row.hit ? ' mock__trow--hit' : ''}`} key={`${row.label}-${row.qty}`}>
              <span>{row.label}</span>
              <span>{row.qty}</span>
              <span>{row.amount}</span>
              {row.hit && (
                <>
                  <span className="mock__ring" aria-hidden="true" />
                  <BibataCursor className="mock__cursor" />
                </>
              )}
            </div>
          ))}
          <div className="mock__trow mock__trow--total">
            <span>{t('feature.totalDue')}</span>
            <span />
            <strong>$4,280.00</strong>
          </div>
        </div>
        <div className="mock__layers" aria-hidden="true">
          <span>Cell C14</span>
          <span>2 rows matched</span>
        </div>
      </div>
    </div>
  );
}

function AnswerStage() {
  const seq = useSpiritSequence(DIP_DEMO, { auto: true });
  const hostRef = useRef<HTMLDivElement>(null);
  useSpiritAnchor(hostRef);

  return (
    <div className="fsence" ref={hostRef} data-ui>
      <div className="mock mock--answer">
        <Bar file="Q3-revenue.pdf" />
        <div className="mock__page mock__page--chart">
          <div className="mock__head">
            <span>Monthly billed</span>
            <span>Q3</span>
          </div>
          <div className="mock__note">
            <i aria-hidden="true" />
            <span>March dip · billing timing, not churn</span>
          </div>
          <div className="mock__chart" aria-hidden="true">
            {REVENUE_BARS.map((bar) => (
              <div className={`mock__col${bar.hi ? ' is-hi' : ''}`} key={bar.month}>
                <span className="mock__val">{bar.value}</span>
                <span className="mock__track">
                  <i style={{ height: `${bar.h}%` }} />
                </span>
                <span className="mock__mon">{bar.month}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="fsence__spirit">
        <SpiritBox
          seq={seq}
          demo={DIP_DEMO}
          phase={seq.phase}
          ctxChips={['Q3-revenue.pdf']}
          staticCursor
        />
      </div>
    </div>
  );
}

function ActStage() {
  const seq = useSpiritSequence(EXPORT_DEMO, { auto: true });
  const hostRef = useRef<HTMLDivElement>(null);
  useSpiritAnchor(hostRef);

  return (
    <div className="fsence" ref={hostRef} data-ui>
      <div className="mock mock--act">
        <Bar file="pipeline.csv" />
        <div className="mock__page mock__page--pipe">
          <div className="mock__head">
            <span>Pipeline</span>
            <span>128 rows</span>
          </div>
          <div className="mock__funnel" aria-hidden="true">
            {PIPELINE_STAGES.map((stage) => (
              <div className="mock__stage" key={stage.label}>
                <span className="mock__stage-name">{stage.label}</span>
                <span className="mock__stage-track">
                  <i style={{ width: `${stage.w}%` }} />
                </span>
                <b className="mock__stage-n">{stage.count}</b>
              </div>
            ))}
          </div>
          <div className="mock__table">
            {PIPELINE_DEALS.map((deal) => (
              <div className={`mock__trow mock__deal${deal.hit ? ' mock__trow--hit' : ''}`} key={deal.name}>
                <span>{deal.name}</span>
                <span className="mock__pill">{deal.stage}</span>
                <span>{deal.value}</span>
              </div>
            ))}
          </div>
          <div className="mock__export">
            <span>Export CSV</span>
            <span className="mock__pill mock__pill--accent">128 rows</span>
          </div>
        </div>
      </div>
      <div className="fsence__spirit">
        <SpiritBox
          seq={seq}
          demo={EXPORT_DEMO}
          phase={seq.phase}
          ctxChips={['pipeline.csv']}
          staticCursor
        />
      </div>
    </div>
  );
}

export default function FeatureStage({ variant }: { variant: 'read' | 'answer' | 'act' }) {
  if (variant === 'read') return <ReadStage />;
  if (variant === 'answer') return <AnswerStage />;
  return <ActStage />;
}
