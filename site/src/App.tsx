import Nav from './components/Nav';
import Footer from './components/Footer';
import SiteSkeleton, { type SkeletonPhase } from './components/SiteSkeleton';
import SpiritOverlay from './components/SpiritOverlay';
import Landing from './pages/Landing';
import Docs from './pages/Docs';
import Legal from './pages/Legal';
import Faq from './pages/Faq';
import DevDocs from './pages/DevDocs';
import { useEffect, useState } from 'react';
import { initScrollFX } from './lib/scrollfx';
import { AsciiReveal } from 'ascii-reveal';

const SHAPE_AT_MS = 120;
const READY_AT_MS = 1900;

type BootPhase = SkeletonPhase | 'ready';

export default function App({
  page = 'index',
}: { page?: 'index' | 'docs' | 'legal' | 'devdocs' | 'faq' | 'terms' | 'privacy' }) {
  const [phase, setPhase] = useState<BootPhase>('box');
  const [revealed, setRevealed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ready = phase === 'ready';

  useEffect(() => {
    let alive = true;
    const timers: number[] = [];
    const started = performance.now();

    timers.push(
      window.setTimeout(() => {
        if (alive) setPhase('shape');
      }, SHAPE_AT_MS),
    );

    const finish = () => {
      if (!alive) return;
      const wait = Math.max(0, READY_AT_MS - (performance.now() - started));
      timers.push(
        window.setTimeout(() => {
          if (alive) setPhase('ready');
        }, wait),
      );
    };

    if (document.fonts?.ready) {
      document.fonts.ready.then(finish).catch(finish);
    } else {
      finish();
    }

    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (!revealed) return;
    return initScrollFX();
  }, [revealed]);

  // Language switch: the boot-reveal scrambles the page out through the
  // ascii grid, then the new language decodes in.
  useEffect(() => {
    let timer = 0;
    const onLocaleChanged = () => {
      setSwitching(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setSwitching(false), 620);
    };
    window.addEventListener('spirit:locale-changed', onLocaleChanged);
    return () => {
      window.removeEventListener('spirit:locale-changed', onLocaleChanged);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <>
      {ready && (
        <>
          <SpiritOverlay />
          <a className="skip" href="#main">
            Skip to content
          </a>
          <Nav page={page} />
        </>
      )}
      <AsciiReveal
        className="boot-reveal"
        preset="dither"
        duration="fast"
        revealOnMount={false}
        lazy={false}
        loading={!ready || switching}
        onRevealComplete={() => setRevealed(true)}
      >
        {ready ? (
          <div className="site__content">
            <main id="main">
              {page === 'docs' ? (
                <Docs />
              ) : page === 'legal' ? (
                <Legal />
              ) : page === 'devdocs' ? (
                <DevDocs />
              ) : page === 'faq' ? (
                <Faq />
              ) : page === 'terms' ? (
                <Legal only="terms" />
              ) : page === 'privacy' ? (
                <Legal only="privacy" />
              ) : (
                <Landing />
              )}
            </main>
            <Footer />
          </div>
        ) : (
          <SiteSkeleton phase={phase} page={page === 'index' ? 'landing' : 'text'} />
        )}
      </AsciiReveal>
    </>
  );
}
