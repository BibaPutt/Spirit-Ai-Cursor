import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { DEV_DOCS } from '../data/devdocs';
import { markdownToHtml } from '../lib/markdown';
import DocSearch from '../components/docs/DocSearch';
import { DocAnnotateDemo, DocBoxDemo, DocToolsDemo } from '../components/docs/DocDemos';
import { useCodeCopy } from '../lib/useCodeCopy';
import type { DocSearchEntry } from '../lib/docsearch';

// Manual sections get indexed too, so "/" finds the user manual from any
// documentation page.
const MANUAL_SECTIONS: Array<{ id: string; tocKey: string; bodyKeys: string[] }> = [
  { id: 'install', tocKey: 'docs.toc.install', bodyKeys: ['docs.install.body1', 'docs.install.body2'] },
  { id: 'use', tocKey: 'docs.toc.use', bodyKeys: ['docs.use.body1', 'docs.use.body2'] },
  { id: 'demo', tocKey: 'docs.toc.demo', bodyKeys: ['docs.demo.body1', 'docs.demo.body2'] },
  {
    id: 'ghost',
    tocKey: 'docs.toc.ghost',
    bodyKeys: ['docs.ghost.body1', 'docs.ghost.body2', 'docs.ghost.body3'],
  },
  {
    id: 'shortcuts',
    tocKey: 'docs.toc.shortcuts',
    bodyKeys: ['docs.shortcuts.0.desc', 'docs.shortcuts.1.desc', 'docs.shortcuts.2.desc', 'docs.shortcuts.3.desc'],
  },
  { id: 'changes', tocKey: 'docs.toc.changes', bodyKeys: ['docs.changes.v10', 'docs.changes.v11', 'docs.changes.v12', 'docs.changes.v13'] },
  { id: 'privacy', tocKey: 'docs.toc.privacy', bodyKeys: ['docs.privacy.body'] },
  { id: 'license', tocKey: 'docs.toc.license', bodyKeys: ['docs.license.body'] },
  { id: 'credits', tocKey: 'docs.toc.credits', bodyKeys: ['docs.credits.body'] },
];

function localized(t: (k: string) => string, key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

function stripMd(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/[#>*`[\]()]/g, ' ')
    .replace(/\s+/g, ' ');
}

const USING = DEV_DOCS.filter((d) => d.group === 'using');
const UNDER = DEV_DOCS.filter((d) => (d.group ?? 'under') === 'under');

export default function DevDocs() {
  const { t } = useI18n();
  const [active, setActive] = useState(DEV_DOCS[0].id);
  const [progress, setProgress] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useCodeCopy(bodyRef, 1);

  useEffect(() => {
    const onScroll = () => {
      const first = document.getElementById(DEV_DOCS[0].id);
      const last = document.getElementById(DEV_DOCS[DEV_DOCS.length - 1].id);
      if (!first || !last) return;

      const start = first.getBoundingClientRect().top + window.scrollY - 150;
      const end = last.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
      const next = end > start ? (window.scrollY - start) / (end - start) : 0;
      setProgress(Math.min(1, Math.max(0, next)));

      let current = DEV_DOCS[0].id;
      for (const doc of DEV_DOCS) {
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
  }, []);

  const entries: DocSearchEntry[] = useMemo(
    () => [
      ...DEV_DOCS.map((doc) => ({
        sectionId: doc.id,
        pageUrl: '/dev-docs.html',
        pageLabel: t('nav.devdocs'),
        title: localized(t, `doc.${doc.id}.title`, doc.title),
        text: `${localized(t, `doc.${doc.id}.plain`, doc.plain)} ${stripMd(doc.md)}`,
      })),
      ...MANUAL_SECTIONS.map((s) => ({
        sectionId: s.id,
        pageUrl: '/docs.html',
        pageLabel: t('nav.manual'),
        title: t(s.tocKey),
        text: s.bodyKeys.map((k) => t(k)).join(' '),
      })),
      ...[
        { id: 'terms', titleKey: 'legal.toc.terms' },
        { id: 'privacy', titleKey: 'legal.toc.privacy' },
        { id: 'credits', titleKey: 'legal.toc.credits' },
        { id: 'license', titleKey: 'legal.toc.license' },
      ].map((s) => ({
        sectionId: s.id,
        pageUrl: '/legal.html',
        pageLabel: t('legal.toc.label'),
        title: t(s.titleKey),
        text: t(s.titleKey),
      })),
    ],
    [t],
  );

  return (
    <article className="docs wrap">
      <header className="docs-hero">
        <h1 data-fx="split">{t('devdocs.title')}</h1>
        <p className="lede" data-fx="fade" data-delay="0.06">
          {t('devdocs.lede')}
        </p>
      </header>

      <div className="docs-grid">
        <aside className="docs-toc" aria-label={t('devdocs.toc.label')}>
          <DocSearch entries={entries} />
          <span className="docs-toc__line" aria-hidden="true">
            <span className="docs-toc__fill" style={{ transform: `scaleY(${progress})` }} />
          </span>
          {USING.length > 0 && <span className="docs-toc__group">{t('devdocs.group.using')}</span>}
          {USING.map((doc) => (
            <a
              key={doc.id}
              href={`#${doc.id}`}
              className={active === doc.id ? 'is-active' : undefined}
            >
              {localized(t, `doc.${doc.id}.title`, doc.title)}
            </a>
          ))}
          {UNDER.length > 0 && <span className="docs-toc__group">{t('devdocs.group.under')}</span>}
          {UNDER.map((doc) => (
            <a
              key={doc.id}
              href={`#${doc.id}`}
              className={active === doc.id ? 'is-active' : undefined}
            >
              {localized(t, `doc.${doc.id}.title`, doc.title)}
            </a>
          ))}
        </aside>

        <div className="docs-body" ref={bodyRef}>
          {DEV_DOCS.map((doc) => (
            <section id={doc.id} key={doc.id}>
              <h2 data-fx="split">{localized(t, `doc.${doc.id}.title`, doc.title)}</h2>
              <div className="doc-plain">
                <span className="doc-plain-label">{t('devdocs.plain.label')}</span>
                {localized(t, `doc.${doc.id}.plain`, doc.plain)}
              </div>
              <div className="rich-doc" dangerouslySetInnerHTML={{ __html: markdownToHtml(doc.md) }} />
              {doc.demo === 'box' && <DocBoxDemo />}
              {doc.demo === 'annotate' && <DocAnnotateDemo />}
              {doc.demo === 'tools' && <DocToolsDemo />}
              {(doc.demo === 'box' || doc.demo === 'annotate' || doc.demo === 'tools') && (
                <p className="docdemo__caption">{t('devdocs.demo.label')}</p>
              )}
            </section>
          ))}
          <p>
            <a href="/legal.html">{t('docs.more.legal')} →</a>
          </p>
        </div>
      </div>
    </article>
  );
}
