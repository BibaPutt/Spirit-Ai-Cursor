import { useEffect, useRef, useState } from 'react';
import { AsciiReveal, AsciiSkeleton } from 'ascii-reveal';
import HalftoneWordmark from './HalftoneWordmark';
import { useTheme } from '../theme';
import { useI18n } from '../i18n';

const COLUMNS: { titleKey: string; links: { key: string; href: string }[] }[] = [
  {
    titleKey: 'footer.col.product',
    links: [
      { key: 'footer.link.overview', href: '/' },
      { key: 'footer.link.faq', href: '/faq.html' },
      { key: 'footer.link.how', href: '/#how' },
      { key: 'footer.link.inside', href: '/#inside' },
      { key: 'footer.link.download', href: '/#download' },
    ],
  },
  {
    titleKey: 'footer.col.manual',
    links: [
      { key: 'footer.link.install', href: '/docs.html#install' },
      { key: 'footer.link.shortcuts', href: '/docs.html#shortcuts' },
      { key: 'footer.link.models', href: '/docs.html#models' },
      { key: 'footer.link.changes', href: '/docs.html#changes' },
      { key: 'footer.link.devdocs', href: '/dev-docs.html' },
    ],
  },
  {
    titleKey: 'footer.col.project',
    links: [
      { key: 'footer.link.source', href: 'https://github.com/BibaPutt/Spirit-AI-Cursor' },
      { key: 'footer.link.releases', href: 'https://github.com/BibaPutt/Spirit-AI-Cursor/releases' },
      { key: 'footer.link.bug', href: 'https://github.com/BibaPutt/Spirit-AI-Cursor/issues/new' },
    ],
  },
  {
    titleKey: 'footer.col.legal',
    links: [
      { key: 'footer.link.terms', href: '/terms.html' },
      { key: 'footer.link.privacy', href: '/privacy.html' },
      { key: 'footer.link.credits', href: '/legal.html#credits' },
      { key: 'footer.link.license', href: '/legal.html#license' },
    ],
  },
];

export default function Footer() {
  const { theme } = useTheme();
  const { t } = useI18n();
  const wordmarkRef = useRef<HTMLDivElement | null>(null);
  const [wordmarkVisible, setWordmarkVisible] = useState(false);
  const [wordmarkReady, setWordmarkReady] = useState(false);

  useEffect(() => {
    const node = wordmarkRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setWordmarkVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!wordmarkVisible) return;
    let alive = true;
    let timer = 0;
    const started = performance.now();
    const finish = () => {
      if (!alive) return;
      const wait = Math.max(0, 320 - (performance.now() - started));
      timer = window.setTimeout(() => {
        if (alive) setWordmarkReady(true);
      }, wait);
    };
    if (document.fonts?.ready) {
      document.fonts.ready.then(finish).catch(finish);
    } else {
      finish();
    }
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [wordmarkVisible]);

  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer__top">
          <div className="footer__brand" data-fx="fade">
            <img
              className="footer__mark"
              src="/assets/mark.png"
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            <p className="footer__big" data-fx="split">
              {t('footer.big.a')}
              <br />
              {t('footer.big.b')}
            </p>
            <a className="btn btn--primary footer__cta" href="/docs.html#install">
              {t('footer.install')}
            </a>
          </div>

          <div className="footer__cols" data-fx="stagger">
            {COLUMNS.map((column) => (
              <div className="footer-col" key={column.titleKey}>
                <h3>{t(column.titleKey)}</h3>
                <ul>
                  {column.links.map((link) => (
                    <li key={link.key}>
                      <a href={link.href}>{t(link.key)}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="footer__wordmark" data-fx="fade" ref={wordmarkRef}>
        {wordmarkVisible && (
          <AsciiReveal
            loading={!wordmarkReady}
            preset="dither"
            duration="fast"
            lazy={false}
            className="footer__ascii"
          >
            {wordmarkReady ? (
              <HalftoneWordmark theme={theme} crop={0.28} tone="accent" />
            ) : (
              <AsciiSkeleton
                as="div"
                variant="dither"
                rows={10}
                width="100%"
                height="clamp(150px, 34vw, 480px)"
                className="footer__ascii-skeleton"
              />
            )}
          </AsciiReveal>
        )}
      </div>
    </footer>
  );
}
