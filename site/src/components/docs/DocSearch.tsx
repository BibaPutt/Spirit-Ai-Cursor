import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { searchDocs, type DocSearchEntry, type DocSearchHit } from '../../lib/docsearch';

// Command-palette doc search. The sidebar shows a trigger button; the real
// UI is a centered palette (fumadocs/algolia style): large input, page-
// labeled results with highlighted titles, keyboard hints, body scroll
// lock. "/" or Ctrl/Cmd+K opens it from anywhere on a docs page.

function Highlighted({ text, query }: { text: string; query: string }) {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return <>{text}</>;
  const re = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        re.test(part) && tokens.includes(part.toLowerCase()) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
    <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export default function DocSearch({ entries }: { entries: DocSearchEntry[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef(0);

  const hits: DocSearchHit[] = useMemo(() => searchDocs(entries, query), [entries, query]);

  const openPalette = () => {
    window.clearTimeout(closeTimer.current);
    setClosing(false);
    setQuery('');
    setCursor(0);
    setOpen(true);
  };

  // Closing animates out first (blur drains, panel recedes), then unmounts.
  const requestClose = () => {
    if (!open || closing) return;
    setClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 200);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? ''))) {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const go = (hit: DocSearchHit) => {
    window.clearTimeout(closeTimer.current);
    setOpen(false);
    setClosing(false);
    window.location.href = `${hit.pageUrl}#${hit.sectionId}`;
  };

  return (
    <>
      <button type="button" className="docsearch__trigger" onClick={openPalette}>
        <span className="docsearch__ico" aria-hidden="true">
          <SearchIcon />
        </span>
        <span className="docsearch__trigger-label">{t('devdocs.search.placeholder')}</span>
        <kbd className="docsearch__kbd">/</kbd>
      </button>

      {open &&
        createPortal(
        <div
          className={`docsearch__overlay${closing ? ' is-closing' : ' is-open'}`}
          role="dialog"
          aria-modal="true"
          aria-label={t('devdocs.search.placeholder')}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) requestClose();
          }}
        >
          <div className="docsearch__panel">
            <div className="docsearch__bar">
              <span className="docsearch__ico" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                ref={inputRef}
                type="text"
                className="docsearch__input"
                placeholder={t('devdocs.search.placeholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCursor((c) => Math.min(c + 1, Math.max(0, hits.length - 1)));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCursor((c) => Math.max(c - 1, 0));
                  } else if (e.key === 'Enter' && hits[cursor]) {
                    go(hits[cursor]);
                  }
                }}
                aria-label={t('devdocs.search.placeholder')}
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className="docsearch__kbd" onClick={requestClose}>
                esc
              </kbd>
            </div>

            <div className="docsearch__results" role="listbox" key={query}>
              {query.trim().length < 2 ? (
                <p className="docsearch__empty">{t('devdocs.search.hint')}</p>
              ) : hits.length === 0 ? (
                <p className="docsearch__empty">{t('devdocs.search.empty')}</p>
              ) : (
                hits.map((hit, i) => (
                  <button
                    key={`${hit.pageUrl}#${hit.sectionId}`}
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    className={`docsearch__hit${i === cursor ? ' is-active' : ''}`}
                    style={{ animationDelay: `${i * 22}ms` }}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(hit)}
                  >
                    <span className="docsearch__hit-page">{hit.pageLabel}</span>
                    <span className="docsearch__hit-title">
                      <Highlighted text={hit.title} query={query} />
                    </span>
                    <span className="docsearch__hit-snippet">{hit.snippet}</span>
                  </button>
                ))
              )}
            </div>

            <div className="docsearch__hints" aria-hidden="true">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> {t('devdocs.search.nav')}
              </span>
              <span>
                <kbd>↵</kbd> {t('devdocs.search.open')}
              </span>
              <span>
                <kbd>esc</kbd> {t('devdocs.search.close')}
              </span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
