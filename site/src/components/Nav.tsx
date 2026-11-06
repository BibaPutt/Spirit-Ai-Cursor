import { useEffect, useRef, useState } from 'react';
import ThemeToggle from './ThemeToggle';
import BrandMark from './BrandMark';
import { toggleSpiritPreview } from '../lib/spirit';
import { LOCALES, useI18n } from '../i18n';

const LINKS = [
  { key: 'nav.product', href: '/#product', id: 'product' },
  { key: 'nav.manual', href: '/docs.html', id: 'manual' },
  { key: 'nav.devdocs', href: '/dev-docs.html', id: 'devdocs' },
  { key: 'nav.faq', href: '/faq.html', id: 'faq' },
];

const SPY = ['product', 'download'];

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3.8 12h16.4M12 3.6c2.2 2.3 3.4 5.2 3.4 8.4s-1.2 6.1-3.4 8.4c-2.2-2.3-3.4-5.2-3.4-8.4S9.8 5.9 12 3.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LanguageMenu() {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="lang" ref={ref}>
      <button
        type="button"
        className="lang__toggle"
        aria-label={t('nav.language')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <GlobeIcon />
        <span className="lang__code">{locale.toUpperCase()}</span>
      </button>
      {open && (
        <div
          className="lang__menu"
          role="listbox"
          aria-label={t('nav.language')}
          data-lenis-prevent
        >
          {LOCALES.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.id === locale}
              className={`lang__item${item.id === locale ? ' is-active' : ''}`}
              key={item.id}
              onClick={() => {
                setLocale(item.id);
                setOpen(false);
              }}
            >
              <span className="lang__name">{item.label}</span>
              <span className="lang__en">{item.english}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Nav({
  page = 'index',
}: {
  page?: 'index' | 'docs' | 'legal' | 'devdocs' | 'faq' | 'terms' | 'privacy';
}) {
  const { t } = useI18n();
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState(
    page === 'docs'
      ? 'manual'
      : page === 'devdocs'
        ? 'devdocs'
        : page === 'faq'
          ? 'faq'
          : page === 'legal' || page === 'terms' || page === 'privacy'
            ? ''
            : 'product',
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 12);
      if (page !== 'index') return; // sub-page: keep its own nav item active
      let current = 'product';
      for (const id of SPY) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 180) current = id;
      }
      setActive(current);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [page]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <header className={`nav${scrolled || open ? ' is-scrolled' : ''}`}>
        <div className="nav__inner">
          <a className="nav__brand" href="/" aria-label={t('nav.home')} onClick={() => setOpen(false)}>
            <BrandMark size={22} />
            <span className="nav__brand-word">Spirit</span>
          </a>

          <nav className="nav__links" aria-label={t('nav.primary')}>
            {LINKS.map((link) => (
              <a
                className={`nav__link${active === link.id ? ' is-active' : ''}`}
                href={link.href}
                key={link.id}
                aria-current={active === link.id ? 'page' : undefined}
              >
                {t(link.key)}
              </a>
            ))}
          </nav>

          <div className="nav__side">
            <LanguageMenu />
            <button
              type="button"
              className="btn btn--ghost nav__preview"
              data-spirit-preview-trigger
              onClick={() => toggleSpiritPreview()}
            >
              {t('nav.preview')}
            </button>
            <ThemeToggle showLabel={false} />
            <a className="btn btn--primary btn--beam" href="/docs.html#install">
              {t('nav.get')}
            </a>
            <button
              type="button"
              className={`nav__burger${open ? ' is-open' : ''}`}
              aria-label={open ? t('nav.close') : t('nav.open')}
              aria-expanded={open}
              aria-controls="spirit-menu"
              onClick={() => setOpen((value) => !value)}
            >
              <span />
              <span />
            </button>
          </div>
        </div>
      </header>

      <div id="spirit-menu" className={`menu${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="menu__top">
          <a className="nav__brand" href="/" aria-label={t('nav.home')} onClick={() => setOpen(false)}>
            <BrandMark size={22} />
            <span className="nav__brand-word">Spirit</span>
          </a>
          <button
            type="button"
            className="nav__burger is-open"
            aria-label={t('nav.close')}
            onClick={() => setOpen(false)}
          >
            <span />
            <span />
          </button>
        </div>

        <nav className="menu__links" aria-label={t('nav.mobile')}>
          {LINKS.map((link) => (
            <a className="menu__link" href={link.href} key={link.id} onClick={() => setOpen(false)}>
              {t(link.key)}
            </a>
          ))}
        </nav>

        <div className="menu__foot">
          <a className="btn btn--primary btn--beam" href="/docs.html#install" onClick={() => setOpen(false)}>
            {t('nav.get')}
          </a>
          <ThemeToggle showLabel={false} />
        </div>
      </div>
    </>
  );
}
