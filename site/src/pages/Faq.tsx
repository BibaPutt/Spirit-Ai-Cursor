import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import DocSearch from '../components/docs/DocSearch';
import type { DocSearchEntry } from '../lib/docsearch';

const FAQ = Array.from({ length: 15 }, (_, i) => ({
  title: `faq.${i}.title`,
  body: `faq.${i}.body`,
}));

export default function Faq() {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const first = document.getElementById('q0');
      const last = document.getElementById(`q${FAQ.length - 1}`);
      if (!first || !last) return;
      const start = first.getBoundingClientRect().top + window.scrollY - 150;
      const end = last.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
      const next = end > start ? (window.scrollY - start) / (end - start) : 0;
      setProgress(Math.min(1, Math.max(0, next)));

      let current = 0;
      for (let i = 0; i < FAQ.length; i++) {
        const el = document.getElementById(`q${i}`);
        if (el && el.getBoundingClientRect().top <= 150) current = i;
      }
      setActive(current);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const entries: DocSearchEntry[] = useMemo(
    () =>
      FAQ.map((item, i) => ({
        sectionId: `q${i}`,
        pageUrl: '/faq.html',
        pageLabel: t('nav.faq'),
        title: t(item.title),
        text: t(item.body),
      })),
    [t],
  );

  return (
    <article className="docs wrap">
      <header className="docs-hero">
        <h1 data-fx="split">{t('faq.page.title')}</h1>
        <p className="lede" data-fx="fade" data-delay="0.06">
          {t('faq.body')}
        </p>
      </header>

      <div className="docs-grid">
        <aside className="docs-toc" aria-label={t('legal.toc.label')}>
          <DocSearch entries={entries} />
          <span className="docs-toc__line" aria-hidden="true">
            <span className="docs-toc__fill" style={{ transform: `scaleY(${progress})` }} />
          </span>
          {FAQ.map((item, i) => (
            <a
              key={item.title}
              href={`#q${i}`}
              className={active === i ? 'is-active' : undefined}
            >
              {t(item.title)}
            </a>
          ))}
        </aside>

        <div className="docs-body">
          {FAQ.map((item, i) => (
            <section id={`q${i}`} key={item.title}>
              <h2 data-fx="split">{t(item.title)}</h2>
              <p>{t(item.body)}</p>
            </section>
          ))}
          <p>
            <a href="/docs.html">{t('nav.manual')} →</a>
            <br />
            <a href="/dev-docs.html">{t('nav.devdocs')} →</a>
          </p>
        </div>
      </div>
    </article>
  );
}
