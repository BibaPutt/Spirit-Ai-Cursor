import { useEffect, useRef, useState } from 'react';
import Dither from '../effects/Dither';
import SpiritBox from '../components/spirit/SpiritBox';
import AnnotationFrame from '../components/spirit/AnnotationFrame';
import Marquee from '../components/Marquee';
import Accordion, { type AccordionItem } from '../components/Accordion';
import PromptWall from '../components/PromptWall';
import FeatureStage from '../components/FeatureStage';
import { HERO_DEMO, INVOICE_DEMO } from '../data/demo';
import { toggleSpiritPreview, useSpiritSequence, type SpiritAnnotation } from '../lib/spirit';
import { ditherPalette, useTheme } from '../theme';
import { useI18n } from '../i18n';

const CARDS: {
  title: string;
  body: string;
  tags: string[];
  variant: 'read' | 'answer' | 'act';
}[] = [
  {
    title: 'cards.0.title',
    body: 'cards.0.body',
    tags: ['cards.0.tag.0', 'cards.0.tag.1', 'cards.0.tag.2'],
    variant: 'read',
  },
  {
    title: 'cards.1.title',
    body: 'cards.1.body',
    tags: ['cards.1.tag.0', 'cards.1.tag.1', 'cards.1.tag.2'],
    variant: 'answer',
  },
  {
    title: 'cards.2.title',
    body: 'cards.2.body',
    tags: ['cards.2.tag.0', 'cards.2.tag.1', 'cards.2.tag.2'],
    variant: 'act',
  },
];

const INSIDE: AccordionItem[] = [
  { title: 'inside.0.title', body: 'inside.0.body' },
  { title: 'inside.1.title', body: 'inside.1.body' },
  { title: 'inside.2.title', body: 'inside.2.body' },
  { title: 'inside.3.title', body: 'inside.3.body' },
  { title: 'inside.4.title', body: 'inside.4.body' },
];

const FAQ: AccordionItem[] = [
  { title: 'faq.0.title', body: 'faq.0.body' },
  { title: 'faq.1.title', body: 'faq.1.body' },
  { title: 'faq.2.title', body: 'faq.2.body' },
  { title: 'faq.3.title', body: 'faq.3.body' },
  { title: 'faq.4.title', body: 'faq.4.body' },
  { title: 'faq.5.title', body: 'faq.5.body' },
];

const STEPS = [
  { title: 'steps.0.title', body: 'steps.0.body', tag: 'steps.0.tag' },
  { title: 'steps.1.title', body: 'steps.1.body', tag: 'steps.1.tag' },
  { title: 'steps.2.title', body: 'steps.2.body', tag: 'steps.2.tag' },
];

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M7 17 17 7M7 7h10v10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HeroStage() {
  const { t } = useI18n();
  const spiritRef = useRef<HTMLDivElement>(null);
  const seq = useSpiritSequence(HERO_DEMO, {
    auto: true,
  });

  useEffect(() => {
    const host = spiritRef.current;
    if (!host) return;

    const apply = () => {
      const box = host.querySelector<HTMLElement>('.sbox');
      if (!box) return;
      if (window.innerWidth <= 760) {
        box.style.removeProperty('--sbox-w-wide');
        return;
      }
      const left = box.getBoundingClientRect().left;
      const rail = Math.max(380, Math.min(578, window.innerWidth - left - 12));
      box.style.setProperty('--sbox-w-wide', `${rail}px`);
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
  }, []);

  return (
    <div className="hscene" data-ui>
      <div className="hscene__doc">
        <div className="hscene__bar">
          <span className="hscene__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="hscene__file">{t('hero.file')}</span>
          <span className="hscene__tag">PDF</span>
        </div>

        <div className="hscene__body">
          <div className="hscene__head">
            <span className="hscene__kicker">{t('hero.kicker')}</span>
            <strong>{t('hero.title')}</strong>
          </div>

          <div className="hscene__kpis">
            <div>
              <span>{t('hero.kpi.total')}</span>
              <strong>$4.28M</strong>
              <em>+13%</em>
            </div>
            <div>
              <span>{t('hero.kpi.fastest')}</span>
              <strong>APAC</strong>
              <em>+21%</em>
            </div>
            <div>
              <span>{t('hero.kpi.regions')}</span>
              <strong>4</strong>
              <em>{t('hero.kpi.tracked')}</em>
            </div>
          </div>

          <table className="stage__table">
            <thead>
              <tr>
                <th scope="col">{t('table.region')}</th>
                <th scope="col">{t('table.revenue')}</th>
                <th scope="col">{t('table.yoy')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('region.na')}</td>
                <td className="num">$1,842,000</td>
                <td className="num">+12%</td>
              </tr>
              <tr data-sann-target="apac">
                <td>{t('region.apac')}</td>
                <td className="num">$986,300</td>
                <td className="num">+21%</td>
              </tr>
              <tr>
                <td>{t('region.eu')}</td>
                <td className="num">$1,204,500</td>
                <td className="num">+9%</td>
              </tr>
              <tr>
                <td>{t('region.latam')}</td>
                <td className="num">$247,200</td>
                <td className="num">+4%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="hscene__spirit" ref={spiritRef}>
        <SpiritBox
          seq={seq}
          demo={HERO_DEMO}
          phase={seq.phase}
          ctxChips={[t('hero.file'), 'table']}
          staticCursor
        />
      </div>
    </div>
  );
}

function ProductScene() {
  const { t } = useI18n();
  const [anns, setAnns] = useState<SpiritAnnotation[]>([]);
  const seq = useSpiritSequence(INVOICE_DEMO, {
    auto: true,
    onAnnotation: setAnns,
  });

  return (
    <div className="scene" data-ui data-fx="scene">
      <div className="scene__window" data-fx="parallax" data-speed="4">
        <div className="scene__chrome">
          <span className="scene__lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="scene__file">{t('scene.file.invoice')}</span>
          <span className="scene__page-count">{t('scene.page')}</span>
        </div>
        <div className="scene__page" style={{ position: 'relative' }}>
          <p className="scene__kicker">{t('product.scene.kicker')}</p>
          <h3>{t('product.scene.title')}</h3>
          <p className="scene__body">{t('product.scene.body')}</p>
          <table className="scene__table">
            <thead>
              <tr>
                <th scope="col">{t('table.invoice')}</th>
                <th scope="col">{t('table.row')}</th>
                <th scope="col">{t('table.total')}</th>
              </tr>
            </thead>
            <tbody>
              <tr data-sann-target="row-14" className={anns.length > 0 ? 'is-target' : undefined}>
                <td>{t('product.invoice.march')}</td>
                <td className="num">14</td>
                <td className="num">$4,280.00</td>
              </tr>
              <tr>
                <td>{t('product.invoice.feb')}</td>
                <td className="num">09</td>
                <td className="num">$3,910.00</td>
              </tr>
              <tr>
                <td>{t('product.invoice.jan')}</td>
                <td className="num">22</td>
                <td className="num">$4,120.00</td>
              </tr>
            </tbody>
          </table>
          <p className="scene__note">{t('product.scene.note')}</p>
          <AnnotationFrame annotations={anns} />
        </div>
      </div>

      <div className="scene__spirit" data-fx="slide" data-from="right">
        <SpiritBox
          seq={seq}
          demo={INVOICE_DEMO}
          phase={seq.phase}
          ctxChips={[t('scene.file.invoice'), 'selection']}
          staticCursor
        />
      </div>
    </div>
  );
}

export default function Landing() {
  const { theme } = useTheme();
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const copies = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    const onScroll = () => {
      const mid = window.innerHeight * 0.52;
      let next = 0;
      copies.current.forEach((node, index) => {
        if (!node) return;
        const box = node.getBoundingClientRect();
        if (box.top <= mid && box.bottom >= 0) next = index;
      });
      setActive(next);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <>
      <section className="hero" id="top">
        <div className="hero__field" aria-hidden="true">
          <Dither
            key={`hero-${theme}`}
            pixelSize={4}
            ditherMode="bayer"
            palette={ditherPalette(theme)}
            waveSpeed={0.05}
            contrast={1.02}
            mouseRadius={1.6}
            mouseEffect="ripple"
            trail={0.55}
            intro={false}
            enableMouseInteraction
          />
        </div>

        <div className="wrap hero__inner">
          <div className="hero__copy">
            <p className="hero__eyebrow" data-fx="fade">{t('hero.eyebrow')}</p>
            <h1 className="display hero__title" data-fx="split">
              <span className="hero__title-line">{t('hero.title.a')}</span>
              <br />
              <span className="hero__title-line accent">{t('hero.title.b')}</span>
            </h1>
            <p className="hero__lede" data-fx="fade">{t('hero.lede')}</p>
            <div className="hero__actions">
              <button
                type="button"
                className="btn btn--primary btn--beam"
                data-spirit-preview-trigger
                onClick={() => toggleSpiritPreview()}
              >
                {t('hero.preview')}
              </button>
              <a className="btn btn--ghost" href="/docs.html#install">
                {t('hero.get')}
              </a>
            </div>
            <p className="hero__meta">
              {t('hero.meta')}
              <a className="hero__manual" href="/docs.html">
                {t('hero.manual')}
              </a>
            </p>
          </div>

          <div className="hero__stage" data-fx="fade">
            <HeroStage />
          </div>
        </div>
      </section>

      <Marquee />

      <section className="sec" id="product">
        <div className="wrap">
          <div className="sec-head">
            <h2 className="display-sm sec-head__title" data-fx="split">
              {t('product.title')}
            </h2>
            <p className="lede sec-head__body" data-fx="fade">
              {t('product.body')}
            </p>
          </div>
          <ProductScene />
        </div>
      </section>

      <section className="sec" id="how">
        <div className="wrap">
          <div className="sec-head">
            <h2 className="display-sm sec-head__title" data-fx="split">
              {t('how.title')}
            </h2>
            <div className="sec-head__body" data-fx="fade">
              <p>{t('how.body')}</p>
              <a className="text-link" href="/docs.html#how">
                {t('how.link')}
                <Arrow />
              </a>
            </div>
          </div>

          <div className="work">
            <div className="work__copies">
              {CARDS.map((card, index) => (
                <article
                  className="work__copy"
                  key={card.title}
                  ref={(node) => {
                    copies.current[index] = node;
                  }}
                >
                  <h3>{t(card.title)}</h3>
                  <p>{t(card.body)}</p>
                  <ul className="work__tags">
                    {card.tags.map((tag) => (
                      <li className="chip" key={tag}>
                        {t(tag)}
                      </li>
                    ))}
                  </ul>
                  <div className="work__inline">
                    <FeatureStage variant={card.variant} />
                  </div>
                </article>
              ))}
            </div>

            <div className="work__rail" aria-hidden="true">
              <div className="work__stage">
                {CARDS.map((card, index) => (
                  <div
                    className={`work__scene${active === index ? ' is-active' : ''}`}
                    key={card.title}
                  >
                    <FeatureStage variant={card.variant} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" id="inside">
        <div className="wrap">
          <div className="inside__grid">
            <div className="inside__head">
              <h2 className="display-sm" data-fx="split">
                {t('inside.title')}
              </h2>
              <p className="lede" data-fx="fade">
                {t('inside.body')}
              </p>
            </div>
            <Accordion
              items={INSIDE.map((item) => ({ title: t(item.title), body: t(item.body) }))}
              defaultOpen={0}
              auto
            />
          </div>
        </div>
      </section>

      <section className="sec" id="asked">
        <div className="wrap">
          <div className="asked__grid">
            <div className="asked__head">
              <h2 className="display-sm" data-fx="split">
                {t('asked.title')}
              </h2>
              <p className="lede" data-fx="fade">
                {t('asked.body')}
              </p>
            </div>
            <PromptWall />
          </div>
        </div>
      </section>

      <section className="sec" id="process">
        <div className="wrap process__grid">
          <h2 className="display-sm" data-fx="split">
            {t('process.title')}
          </h2>
          <ol className="steps" data-fx="stagger">
            {STEPS.map((step) => (
              <li className="step" key={step.title}>
                <h3>{t(step.title)}</h3>
                <p>{t(step.body)}</p>
                <span className="chip">{t(step.tag)}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="cta" id="download">
        <div className="cta__field" aria-hidden="true">
          <Dither
            key={`download-${theme}`}
            pixelSize={4}
            ditherMode="bayer"
            palette={ditherPalette(theme)}
            waveSpeed={0.06}
            contrast={1.05}
            mouseRadius={1.4}
            mouseEffect="ripple"
            trail={0.5}
            intro={false}
            enableMouseInteraction
          />
        </div>

        <div className="wrap cta__inner">
          <h2 className="display cta__title" data-fx="split">
            {t('cta.title.a')} <span className="accent">{t('cta.title.b')}</span>
          </h2>

          <div className="cta__foot">
            <div className="cta__copy">
              <p className="lede" data-fx="fade">
                {t('cta.body')}
              </p>
              <div className="cta__actions">
                <a className="btn btn--primary btn--beam" href="/docs.html#install">
                  {t('cta.download')}
                  <Arrow />
                </a>
                <a className="btn btn--ghost" href="/docs.html#install">
                  {t('cta.install')}
                </a>
              </div>
            </div>

            <div className="os" data-ui data-fx="fade" data-delay="0.1">
              <div className="os__row is-active">
                <span className="os__name">{t('os.windows')}</span>
                <span className="os__note">{t('os.windows.note')}</span>
                <span className="os__pick" aria-hidden="true" />
              </div>
              <div className="os__row">
                <span className="os__name">{t('os.macos')}</span>
                <span className="os__note">{t('os.macos.note')}</span>
                <span className="os__pick" aria-hidden="true" />
              </div>
              <div className="os__row">
                <span className="os__name">{t('os.linux')}</span>
                <span className="os__note">{t('os.linux.note')}</span>
                <span className="os__pick" aria-hidden="true" />
              </div>
              <a className="btn btn--primary os__btn" href="/docs.html#install">
                {t('os.download')}
                <Arrow />
              </a>
              <p className="os__meta">{t('os.meta')}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="sec" id="questions">
        <div className="wrap">
          <div className="faq__grid">
            <div className="faq__head">
              <h2 className="display-sm" data-fx="split">
                {t('faq.title')}
              </h2>
              <p className="lede" data-fx="fade">
                {t('faq.body')}
              </p>
            </div>
            <Accordion
              items={FAQ.map((item) => ({ title: t(item.title), body: t(item.body) }))}
              defaultOpen={0}
            />
            <p className="faq__more">
              <a href="/faq.html">{t('faq.more')} →</a>
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
