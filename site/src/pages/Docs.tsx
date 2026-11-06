import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

const TOC = [
  { id: 'install', key: 'docs.toc.install' },
  { id: 'use', key: 'docs.toc.use' },
  { id: 'demo', key: 'docs.toc.demo' },
  { id: 'ghost', key: 'docs.toc.ghost' },
  { id: 'shortcuts', key: 'docs.toc.shortcuts' },
  { id: 'changes', key: 'docs.toc.changes' },
  { id: 'privacy', key: 'docs.toc.privacy' },
  { id: 'license', key: 'docs.toc.license' },
  { id: 'credits', key: 'docs.toc.credits' },
];

const SHORTCUTS = [
  { labelKey: 'docs.shortcuts.0.label', descKey: 'docs.shortcuts.0.desc' },
  { labelKey: 'docs.shortcuts.1.label', descKey: 'docs.shortcuts.1.desc' },
  { labelKey: 'docs.shortcuts.2.label', descKey: 'docs.shortcuts.2.desc' },
  { labelKey: 'docs.shortcuts.3.label', descKey: 'docs.shortcuts.3.desc' },
];

export default function Docs() {
  const { t } = useI18n();
  const [active, setActive] = useState(TOC[0].id);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const first = document.getElementById(TOC[0].id);
      const last = document.getElementById(TOC[TOC.length - 1].id);
      if (!first || !last) return;

      const start = first.getBoundingClientRect().top + window.scrollY - 150;
      const end = last.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
      const next = end > start ? (window.scrollY - start) / (end - start) : 0;
      setProgress(Math.min(1, Math.max(0, next)));

      let current = TOC[0].id;
      for (const item of TOC) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= 150) current = item.id;
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

  return (
    <article className="docs wrap">
      <header className="docs-hero">
        <h1 data-fx="split">{t('docs.title')}</h1>
        <p className="lede" data-fx="fade" data-delay="0.06">
          {t('docs.lede')}
        </p>
      </header>

      <div className="docs-grid">
        <aside className="docs-toc" aria-label={t('docs.toc.label')}>
          <span className="docs-toc__line" aria-hidden="true">
            <span className="docs-toc__fill" style={{ transform: `scaleY(${progress})` }} />
          </span>
          {TOC.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={active === item.id ? 'is-active' : undefined}
            >
              {t(item.key)}
            </a>
          ))}
        </aside>

        <div className="docs-body">
          <section id="install">
            <h2 data-fx="split">{t('docs.install.title')}</h2>
            <p>{t('docs.install.body1')}</p>
            <pre>{`git clone https://github.com/BibaPutt/Spirit-AI-Cursor.git
cd Spirit-AI-Cursor
npm install
npm run build`}</pre>
            <p>{t('docs.install.body2', { mac: '/Applications', win: '%LOCALAPPDATA%' })}</p>
          </section>

          <section id="use">
            <h2 data-fx="split">{t('docs.use.title')}</h2>
            <p>{t('docs.use.body1')}</p>
            <p>{t('docs.use.body2')}</p>
          </section>

          <section id="demo">
            <h2 data-fx="split">{t('docs.demo.title')}</h2>
            <p>{t('docs.demo.body1')}</p>
            <pre>{`SPIRIT_GHOST=1 npm start`}</pre>
            <p>{t('docs.demo.body2')}</p>
          </section>

          <section id="ghost">
            <h2 data-fx="split">{t('docs.ghost.title')}</h2>
            <p>{t('docs.ghost.body1')}</p>
            <p>{t('docs.ghost.body2')}</p>
            <p>{t('docs.ghost.body3')}</p>
          </section>

          <section id="shortcuts">
            <h2 data-fx="split">{t('docs.shortcuts.title')}</h2>
            <ul className="key-list">
              {SHORTCUTS.map((item) => (
                <li key={item.descKey}>
                  <kbd>{t(item.labelKey)}</kbd>
                  <span>{t(item.descKey)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="changes">
            <h2 data-fx="split">{t('docs.changes.title')}</h2>
            <p>
              <strong>1.3</strong> — {t('docs.changes.v13')}
            </p>
            <p>
              <strong>1.2</strong> — {t('docs.changes.v12')}
            </p>
            <p>
              <strong>1.1</strong> — {t('docs.changes.v11')}
            </p>
            <p>
              <strong>1.0</strong> — {t('docs.changes.v10')}
            </p>
          </section>

          <section id="privacy">
            <h2 data-fx="split">{t('docs.privacy.title')}</h2>
            <p>{t('docs.privacy.body')}</p>
            <p>
              <a href="/legal.html#privacy">{t('docs.privacy.link')} →</a>
            </p>
          </section>

          <section id="license">
            <h2 data-fx="split">{t('docs.license.title')}</h2>
            <p>{t('docs.license.body')}</p>
            <p>
              <a href="/legal.html#license">{t('docs.license.link')} →</a>
            </p>
          </section>

          <section id="credits">
            <h2 data-fx="split">{t('docs.credits.title')}</h2>
            <p>{t('docs.credits.body')}</p>
            <p>
              <a href="/legal.html#credits">{t('docs.credits.link')} →</a>
            </p>
          </section>

          <p>
            <a href="/dev-docs.html">{t('docs.more.devdocs')} →</a>
            <br />
            <a href="/legal.html">{t('docs.more.legal')} →</a>
          </p>
        </div>
      </div>
    </article>
  );
}
