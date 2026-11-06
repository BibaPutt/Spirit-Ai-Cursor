// Renders a `[MERMAID]` plain-diagram-text block. Mermaid is a heavy runtime
// dependency, so it is imported lazily (dynamic `import()`) the first time a
// diagram actually renders — a session that never shows a diagram never pays
// for it. Theming follows the current accent + dark/light mode via
// themeVariables; "Copy as PNG" serializes the rendered SVG to a canvas and
// hands the PNG data URL to main, which writes it to the system clipboard
// (explicit user tap only).
//
// Theme note: this codebase INVERTS Tailwind's `dark` convention — see
// App.tsx (documentElement gets the `dark` class when prefers-color-scheme is
// LIGHT). So `html.dark` present = light UI, absent = dark-glass UI. All color
// decisions below must follow that, or diagrams render light-on-light / dark-
// on-dark ("all black everything").
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import { IconArrowsMaximize, IconClipboard, IconRefresh } from '@tabler/icons-react';
import DiagramLightbox from './DiagramLightbox';
import { sanitizeMermaidCode } from '../../electron/llm/mermaid-clean';

type Status = 'loading' | 'ready' | 'error';

type MermaidMod = {
  default: {
    initialize: (cfg: Record<string, unknown>) => void;
    render: (id: string, code: string) => Promise<{ svg: string }>;
  };
};

// The app stores --accent-rgb SPACE-separated ("10 132 255", so it plugs into
// modern `rgb(var(--accent-rgb) / …)` CSS). Mermaid/d3-color only parses the
// classic COMMA form, so normalize here — an unparsable color makes mermaid
// silently fall back to its default base theme (black text on white nodes)
// regardless of the app theme.
export function normalizeAccentRgb(raw: string): string {
  const parts = (raw ?? '').match(/\d+/g) ?? [];
  return parts.length === 3 ? parts.join(', ') : '10, 132, 255';
}

function accentRgb(): string {
  if (typeof document === 'undefined') return normalizeAccentRgb('');
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent-rgb')
    .trim();
  return normalizeAccentRgb(raw);
}

// html.dark = LIGHT UI in this app (see header note). Returns true for the
// white/light pill, false for the default dark-glass pill.
function lightThemeActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

// REST — Weak local models love injecting hardcoded hex colors as mermaid
// directives ("style A fill:#f9f,stroke:#333", "classDef X ...", "linkStyle 0
// ..."). Those clash with the app theme and are the "all black / wrong
// colours" look the user flagged. The directive-stripping and label-quoting
// logic lives in electron/llm/mermaid-clean.ts (shared with the save template);
// sanitizeMermaidCode is applied before every mermaid.render.

// Clamp a diagram's rendered width so tall (graph TD) diagrams scale down to
// fit within maxHeight instead of dominating the answer card. Wide diagrams
// simply fill the parent. viewBoxWidth/viewBoxHeight come from the SVG.
export function diagramFitWidth(
  parentWidth: number,
  viewBoxWidth: number,
  viewBoxHeight: number,
  maxHeight = 320,
): number {
  if (parentWidth <= 0) return 1;
  if (viewBoxWidth <= 0 || viewBoxHeight <= 0) return Math.round(parentWidth);
  const fitByHeight = maxHeight * (viewBoxWidth / viewBoxHeight);
  return Math.max(1, Math.round(Math.min(parentWidth, fitByHeight)));
}

// Render the mermaid code to an SVG string with the given palette. `light`
// picks the light (dark text) or dark-glass (light text) themeVariables —
// "Copy as PNG" always passes light=true so the transparent PNG carries dark
// legible text even when the app UI is in dark-glass mode. A fresh renderId is
// required per call (mermaid keys renders by element id).
async function renderMermaidSvg(code: string, light: boolean, renderId: string): Promise<string> {
  const mod = (await import('mermaid')) as unknown as MermaidMod;
  const mermaid = mod.default ?? mod;
  const rgb = accentRgb();
  const accentSoft = `rgba(${rgb}, 0.18)`;
  const accentBorder = `rgba(${rgb}, 0.45)`;
  const text = light ? '#262626' : '#e5e5e5';
  const line = light ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.2)';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'inherit',
    themeVariables: {
      darkMode: !light,
      background: 'transparent',
      fontFamily: 'inherit',
      fontSize: '13px',
      primaryColor: accentSoft,
      primaryBorderColor: accentBorder,
      primaryTextColor: text,
      secondaryColor: accentSoft,
      secondaryBorderColor: accentBorder,
      tertiaryColor: accentSoft,
      lineColor: line,
      textColor: text,
      mainBkg: accentSoft,
      nodeBorder: accentBorder,
      clusterBkg: accentSoft,
      clusterBorder: accentBorder,
      edgeLabelBackground: light ? 'rgba(255,255,255,0.85)' : 'rgba(23,23,23,0.85)',
      titleColor: text,
    },
  });
  const { svg: rendered } = await mermaid.render(renderId, sanitizeMermaidCode(code));
  return rendered;
}

export function MermaidDiagram({ code }: { code: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = `spirit-mermaid-${uid}`;
  // Rendered palette follows the app theme; tracked here so the effect
  // re-renders an EXISTING diagram when the user flips dark/light (otherwise
  // an already-painted diagram keeps its old text colors).
  const light = lightThemeActive();
  const containerRef = useRef<HTMLDivElement>(null);
  // The lightbox mounts a FRESH copy of the svg string, so the inline
  // fit-styles the effect below stamps on the card copy do not carry over. A
  // viewBox-only svg with `width: auto` collapses to 0x0 inside the lightbox's
  // flex pane, so the effect below stamps the viewBox size as explicit
  // width/height attributes on the lightbox copy.
  const largeRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [showLarge, setShowLarge] = useState(false);
  // Manual "Remake" retries the render (the effect depends on it) — useful for
  // transient failures and after the sanitizer gets a fix.
  const [attempt, setAttempt] = useState(0);
  // Single timer for both the success tick and the failure flash, so a rapid
  // re-click never leaves a stale state showing.
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let active = true;
    setStatus('loading');
    setSvg('');
    setError('');
    const load = async () => {
      try {
        const rendered = await renderMermaidSvg(code, light, id);
        if (!active || cancelled) return;
        setSvg(rendered);
        setStatus('ready');
      } catch (e) {
        if (!active || cancelled) return;
        const msg = e instanceof Error ? e.message : 'Could not render diagram';
        console.error('[mermaid] render failed:', msg);
        console.error('[mermaid] sanitized code:', sanitizeMermaidCode(code));
        console.error('[mermaid] original code:', code);
        setError(msg);
        setStatus('error');
      }
    };
    void load();
    return () => {
      active = false;
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, code, light, attempt]);

  // Constrain the rendered SVG: fill the card width up to a height budget, so
  // tall diagrams shrink instead of overflowing the 360px answer scroll area.
  useLayoutEffect(() => {
    if (status !== 'ready') return;
    const svgEl = containerRef.current?.querySelector('svg');
    const parent = svgEl?.parentElement;
    if (!svgEl || !parent) return;
    const fit = () => {
      const vb = svgEl.viewBox?.baseVal;
      const parentWidth = parent.clientWidth || 460;
      if (vb && vb.width > 0 && vb.height > 0) {
        const fitW = diagramFitWidth(parentWidth, vb.width, vb.height);
        svgEl.style.setProperty('max-width', `${fitW}px`);
      } else {
        svgEl.style.setProperty('max-width', '100%');
      }
      svgEl.style.setProperty('width', '100%');
      svgEl.style.setProperty('height', 'auto');
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [status, svg]);

  // Give the lightbox copy its natural (viewBox) size so it cannot collapse;
  // the pane scrolls when it exceeds the screen. Runs before paint, so the
  // swap to attributes never flashes a 0x0 svg.
  useLayoutEffect(() => {
    if (!showLarge || status !== 'ready') return;
    const svgEl = largeRef.current?.querySelector('svg');
    const vb = svgEl?.viewBox?.baseVal;
    if (svgEl && vb && vb.width > 0 && vb.height > 0) {
      svgEl.setAttribute('width', String(Math.round(vb.width)));
      svgEl.setAttribute('height', String(Math.round(vb.height)));
    }
  }, [showLarge, status, svg]);

  const copyPng = useCallback(async () => {
    // Clear any pending success/failure flash from a previous click.
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setCopied(false);
    setCopyError('');
    const svgEl = containerRef.current?.querySelector('svg');
    if (!svgEl) {
      setCopyError('Diagram not ready');
      flashTimerRef.current = window.setTimeout(() => {
        setCopyError('');
        flashTimerRef.current = null;
      }, 2000);
      return;
    }
    try {
      const rect = svgEl.getBoundingClientRect();
      let width = Math.max(1, Math.round(rect.width));
      let height = Math.max(1, Math.round(rect.height));
      // Fall back to the viewBox when the live rect is degenerate (0-sized
      // during a layout settle) — never hand main an empty canvas.
      const vb = svgEl.viewBox?.baseVal;
      if ((width <= 0 || height <= 0) && vb && vb.width > 0 && vb.height > 0) {
        width = Math.round(vb.width);
        height = Math.round(vb.height);
      }
      // Highest-quality raster: draw the vector SVG at 4x so text and lines
      // stay crisp in editors/docs. Cap the canvas so oversized diagrams (very
      // wide or tall) can't exceed the browser's canvas dimension limit — fall
      // back to a lower multiplier that still fits.
      let scale = 4;
      const MAX_CANVAS_DIM = 8192;
      while (scale > 1 && (width * scale > MAX_CANVAS_DIM || height * scale > MAX_CANVAS_DIM)) {
        scale--;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // No fillRect — the PNG stays transparent so the diagram pastes over any
      // background (themeVariables already render the SVG on transparent).

      // Re-render the diagram with the LIGHT palette (dark text) so the
      // transparent PNG is legible on white even when the app UI is dark-glass.
      // A fresh render id avoids colliding with the displayed render.
      const lightSvg = await renderMermaidSvg(code, true, `${id}-copy`);
      const holder = document.createElement('div');
      holder.innerHTML = lightSvg;
      const copyEl = holder.querySelector('svg');
      if (!copyEl) throw new Error('Could not render diagram');
      copyEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      copyEl.setAttribute('width', String(width));
      copyEl.setAttribute('height', String(height));
      copyEl.style.removeProperty('max-width');
      copyEl.style.width = `${width}px`;
      copyEl.style.height = `${height}px`;
      // Force transparency on the copy regardless of what mermaid left on it —
      // the copied PNG must always have a clear bg.
      copyEl.style.setProperty('background', 'transparent');
      copyEl.style.setProperty('background-color', 'transparent');
      const xml = new XMLSerializer().serializeToString(copyEl);
      // Data URL, NOT blob: — the app CSP allows `img-src data:` but not
      // `blob:`, so a blob SVG silently fires img.onerror (Copy always failed).
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not load the diagram image'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      });
      if (!img.naturalWidth) throw new Error('Could not load the diagram image');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      const result = await ipc.copyImageToClipboard(dataUrl);
      if (!result.ok) throw new Error(result.error ?? 'Clipboard copy failed');
      setCopied(true);
      flashTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        flashTimerRef.current = null;
      }, 1500);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : 'Copy failed');
      flashTimerRef.current = window.setTimeout(() => {
        setCopyError('');
        flashTimerRef.current = null;
      }, 2000);
    }
  }, [id, code]);

  return (
    <div className={`my-1.5 w-full min-w-0 rounded-lg border border-white/10 bg-white/5 dark:border-neutral-900/10 dark:bg-neutral-900/5`}>
      {status === 'loading' && (
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
          <span className="text-[11px] text-white/55 dark:text-neutral-900/60">Rendering diagram…</span>
        </div>
      )}
      {status === 'error' && (
        <div className="px-3 py-2.5">
          <p className="text-[11px] text-rose-400 dark:text-rose-700">Could not render diagram: {error}</p>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] text-white/45 dark:text-neutral-900/45">
            {code}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              title="Re-run the render (manual retry)"
              className="flex items-center gap-1.5 rounded-full bg-white/8 px-2.5 py-0.5 text-[10.5px] font-medium text-white/70 transition hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90"
            >
              <IconRefresh size={12} stroke={2} />
              Remake
            </button>
            <button
              type="button"
              onClick={() => {
                const msg = `Could not render diagram: ${error}\n\n--- sanitized ---\n${sanitizeMermaidCode(code)}\n\n--- original ---\n${code}`;
                void navigator.clipboard.writeText(msg);
              }}
              title="Copy the error + diagram source, paste it back to Spirit to redraw"
              className="flex items-center gap-1.5 rounded-full bg-white/8 px-2.5 py-0.5 text-[10.5px] font-medium text-white/70 transition hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90"
            >
              <IconClipboard size={12} stroke={2} />
              Copy error
            </button>
          </div>
        </div>
      )}
      {status === 'ready' && (
        <>
          <div ref={containerRef} className="overflow-x-auto px-2 py-1.5">
            <div
              className="mermaid-diagram mx-auto"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-white/8 px-2 py-1 dark:border-neutral-900/8">
            <button
              type="button"
              onClick={() => setShowLarge(true)}
              title="View the diagram at full size"
              className="flex items-center gap-1.5 rounded-full bg-white/8 px-2.5 py-0.5 text-[10.5px] font-medium text-white/70 transition hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90"
            >
              <IconArrowsMaximize size={12} stroke={2} />
              View large
            </button>
            <button
              type="button"
              onClick={() => void copyPng()}
              disabled={status !== 'ready'}
              title={copyError || 'Copy the diagram as a PNG image'}
              className={[
                'flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium transition disabled:opacity-50',
                copied
                  ? 'bg-accent/15 text-accent'
                  : copyError
                    ? 'bg-rose-500/15 text-rose-500 dark:text-rose-700'
                    : 'bg-white/8 text-white/70 hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90',
              ].join(' ')}
            >
              <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.3">
                {copied ? (
                  <path d="M3.5 7.5 6 10l4.5-6" strokeLinecap="round" strokeLinejoin="round" />
                ) : copyError ? (
                  <>
                    <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" strokeLinecap="round" />
                    <rect x="3" y="3" width="8" height="8" rx="1.5" />
                  </>
                ) : (
                  <>
                    <rect x="3" y="3" width="8" height="8" rx="1.5" />
                    <path d="M5 5h5.5a1 1 0 0 1 1 1V11" />
                  </>
                )}
              </svg>
              {copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy as PNG'}
            </button>
          </div>
        </>
      )}
      {showLarge && status === 'ready' && (
        <DiagramLightbox title="Diagram" onClose={() => setShowLarge(false)}>
          <div ref={largeRef} className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
        </DiagramLightbox>
      )}
    </div>
  );
}
