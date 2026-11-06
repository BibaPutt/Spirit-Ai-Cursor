import type { CSSProperties } from 'react';
import { AsciiSkeleton } from 'ascii-reveal';

export type SkeletonPhase = 'box' | 'shape';

export default function SiteSkeleton({
  phase,
  page = 'landing',
}: {
  phase: SkeletonPhase;
  /** 'landing' — the hero/scene shape; 'text' — the docs/legal/manual shape.
      The text skeleton reuses the REAL page containers (.docs.wrap,
      docs-hero, docs-grid, docs-toc, docs-body), so the skeleton sits exactly
      where the content will decode in — no offset jump on reveal. */
  page?: 'landing' | 'text';
}) {
  return (
    <div className={`site-skeleton is-${phase}${page === 'text' ? ' is-text' : ''}`} aria-hidden="true">
      <div className="site-skeleton__nav sk-piece" style={{ '--i': 0 } as CSSProperties}>
        <AsciiSkeleton rows={1} width={116} height={20} seed={1} />
        <div className="site-skeleton__links">
          <AsciiSkeleton rows={1} width={58} height={12} seed={2} />
          <AsciiSkeleton rows={1} width={62} height={12} seed={3} />
          <AsciiSkeleton rows={1} width={44} height={12} seed={4} />
          <AsciiSkeleton rows={1} width={38} height={12} seed={5} />
        </div>
        <div className="site-skeleton__nav-actions">
          <AsciiSkeleton rows={1} width={64} height={38} seed={6} />
          <AsciiSkeleton rows={1} width={122} height={38} seed={6} />
          <AsciiSkeleton rows={1} width={38} height={38} seed={6} />
          <AsciiSkeleton rows={1} width={104} height={38} seed={6} />
        </div>
      </div>

      {page === 'text' ? (
        <div className="docs wrap">
          <header className="docs-hero">
            <div className="sk-piece" style={{ '--i': 1 } as CSSProperties}>
              <AsciiSkeleton
                as="div"
                rows={1}
                width="min(380px, 70%)"
                height="clamp(40px, 4.5vw, 62px)"
                seed={7}
              />
              <AsciiSkeleton as="div" lines={2} widths={['82%', '56%']} seed={8} />
            </div>
          </header>

          <div className="docs-grid">
            <aside className="docs-toc">
              <div className="sk-piece" style={{ '--i': 2 } as CSSProperties}>
                <AsciiSkeleton rows={1} width="100%" height={38} seed={9} />
                <AsciiSkeleton
                  as="div"
                  lines={6}
                  widths={['78%', '88%', '64%', '92%', '70%', '84%']}
                  seed={10}
                />
                <AsciiSkeleton
                  as="div"
                  lines={4}
                  widths={['58%', '80%', '66%', '74%']}
                  seed={11}
                />
              </div>
            </aside>

            <div className="docs-body">
              <div className="sk-piece" style={{ '--i': 3 } as CSSProperties}>
                <AsciiSkeleton as="div" rows={1} width={180} height={24} seed={12} />
                <AsciiSkeleton as="div" lines={2} widths={['96%', '88%']} seed={13} />
              </div>
              <div className="sk-piece" style={{ '--i': 4 } as CSSProperties}>
                <AsciiSkeleton as="div" lines={4} widths={['100%', '94%', '98%', '62%']} seed={14} />
                <AsciiSkeleton as="div" rows={4} width="100%" height={104} seed={15} />
              </div>
              <div className="sk-piece" style={{ '--i': 5 } as CSSProperties}>
                <AsciiSkeleton as="div" lines={3} widths={['92%', '86%', '54%']} seed={16} />
                <AsciiSkeleton
                  as="div"
                  rows={3}
                  width="100%"
                  height="clamp(90px, 12vw, 150px)"
                  seed={17}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="site-skeleton__hero">
            <div className="site-skeleton__copy sk-piece" style={{ '--i': 1 } as CSSProperties}>
              <AsciiSkeleton rows={1} width={128} height={12} seed={7} />
              <AsciiSkeleton
                as="div"
                rows={2}
                width="88%"
                height="clamp(48px, 6vw, 88px)"
                seed={8}
              />
              <AsciiSkeleton as="div" lines={3} widths={['92%', '80%', '56%']} seed={9} />
              <div className="site-skeleton__actions">
                <AsciiSkeleton rows={1} width={172} height={44} seed={10} />
                <AsciiSkeleton rows={1} width={116} height={44} seed={11} />
              </div>
            </div>

            <div className="site-skeleton__scene sk-piece" style={{ '--i': 2 } as CSSProperties}>
              <div className="site-skeleton__scene-bar">
                <AsciiSkeleton rows={1} width={150} height={12} seed={12} />
                <AsciiSkeleton rows={1} width={42} height={12} seed={13} />
              </div>
              <AsciiSkeleton as="div" rows={2} width="100%" height={52} seed={14} />
              <AsciiSkeleton as="div" lines={3} widths={['100%', '100%', '72%']} seed={15} />
              <AsciiSkeleton as="div" rows={5} width="100%" height="clamp(150px, 19vw, 230px)" seed={16} />
            </div>
          </div>

          <div className="site-skeleton__sections">
            <div className="sk-piece" style={{ '--i': 3 } as CSSProperties}>
              <AsciiSkeleton as="div" lines={3} widths={['58%', '82%', '64%']} seed={17} />
            </div>
            <div className="sk-piece" style={{ '--i': 4 } as CSSProperties}>
              <AsciiSkeleton as="div" lines={3} widths={['66%', '88%', '52%']} seed={18} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
