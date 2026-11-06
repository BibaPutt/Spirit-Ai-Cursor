import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { LEGAL_DOCS } from '../data/legal';
import DocSearch from '../components/docs/DocSearch';
import { useCodeCopy } from '../lib/useCodeCopy';
import type { DocSearchEntry } from '../lib/docsearch';

export default function Legal({ only }: { only?: 'terms' | 'privacy' | 'credits' | 'license' } = {}) {
  const { t } = useI18n();
  const [active, setActive] = useState(LEGAL_DOCS[0].id);
  const [progress, setProgress] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useCodeCopy(bodyRef, 1);

  const docs = only ? LEGAL_DOCS.filter((d) => d.id === only) : LEGAL_DOCS;

  const entries: DocSearchEntry[] = useMemo(
    () => [
      ...LEGAL_DOCS.map((doc) => ({
        sectionId: doc.id,
        pageUrl: '/legal.html',
        pageLabel: t('legal.title'),
        title: t(doc.titleKey),
        text: doc.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
      })),
    ],
    [t],
  );

  useEffect(() => {
    const onScroll = () => {
      const first = document.getElementById(only ?? LEGAL_DOCS[0].id);
      const last = only
        ? document.querySelector('.docs-body')?.lastElementChild
        : document.getElementById(LEGAL_DOCS[LEGAL_DOCS.length - 1].id);
      if (!first || !last) return;

      const start = first.getBoundingClientRect().top + window.scrollY - 150;
      const end = last.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
      const next = end > start ? (window.scrollY - start) / (end - start) : 0;
      setProgress(Math.min(1, Math.max(0, next)));

      if (only) return;
      let current = LEGAL_DOCS[0].id;
      for (const doc of LEGAL_DOCS) {
        const el = document.getElementById(doc.id);
        if (el && el.getBoundingClientRect().top <= 150) current = doc.id;
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
  }, [only]);

  return (
    <article className="docs wrap">
      <header className="docs-hero">
        <h1 data-fx="split">{only ? t(docs[0].titleKey) : t('legal.title')}</h1>
        <p className="lede" data-fx="fade" data-delay="0.06">
          {only ? t('legal.updated') : t('legal.lede')}
        </p>
      </header>

      {only ? (
        <div className="docs-grid">
          <aside className="docs-toc" aria-label={t('legal.toc.label')}>
            <DocSearch entries={entries} />
            <span className="docs-toc__line" aria-hidden="true">
              <span className="docs-toc__fill" style={{ transform: `scaleY(${progress})` }} />
            </span>
            {LEGAL_DOCS.map((doc) => {
              const href =
                doc.id === 'terms' ? '/terms.html' : doc.id === 'privacy' ? '/privacy.html' : `/legal.html#${doc.id}`;
              return (
                <a key={doc.id} href={href} className={doc.id === only ? 'is-active' : undefined}>
                  {t(doc.titleKey)}
                </a>
              );
            })}
          </aside>
          <div className="docs-body" ref={bodyRef}>
            {docs.map((doc) => (
              <section id={doc.id} key={doc.id}>
                <h2 data-fx="split">{t(doc.titleKey)}</h2>
                <p className="legal-updated">{t('legal.updated')}</p>
                <div className="rich-doc" dangerouslySetInnerHTML={{ __html: doc.html }} />
              </section>
            ))}
            <p>
              <a href="/legal.html">{t('docs.more.legal')} →</a>
            </p>
          </div>
        </div>
      ) : (
      <div className="docs-grid">
        <aside className="docs-toc" aria-label={t('legal.toc.label')}>
          <DocSearch entries={entries} />
          <span className="docs-toc__line" aria-hidden="true">
            <span className="docs-toc__fill" style={{ transform: `scaleY(${progress})` }} />
          </span>
          {LEGAL_DOCS.map((doc) => (
            <a
              key={doc.id}
              href={`#${doc.id}`}
              className={active === doc.id ? 'is-active' : undefined}
            >
              {t(doc.tocKey)}
            </a>
          ))}
        </aside>

        <div className="docs-body" ref={bodyRef}>
          {docs.map((doc) => (
            <section id={doc.id} key={doc.id}>
              <h2 data-fx="split">{t(doc.titleKey)}</h2>
              <p className="legal-updated">{t('legal.updated')}</p>
              <div className="rich-doc" dangerouslySetInnerHTML={{ __html: doc.html }} />
            </section>
          ))}
          <p className="legal-contact">{t('legal.contact')}</p>
        </div>
      </div>
      )}
    </article>
  );
}
