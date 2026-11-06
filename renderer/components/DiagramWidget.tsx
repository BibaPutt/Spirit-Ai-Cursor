// Renders a `[DIAGRAM]` block — HTML the model authored by filling the fixed
// .dg-* template vocabulary (see the diagram-design skill). The payload was
// already sanitized in main (custom-ui-parse → sanitizeDiagramHtml) before it
// crossed the IPC boundary, so injecting here is safe: no script/style/URL
// material survives, and innerHTML never runs script tags anyway. All styling
// comes from the scoped .spirit-diagram / .dg-* rules in globals.css so the
// widget keeps the app's accent + dark/light theme without the model ever
// touching colours, coordinates or layout.
//
// Header actions: "View large" opens the shared DiagramLightbox with the
// (unclamped, natural-size) diagram; "Copy as PNG" asks main to rasterize the
// widget's LIVE pixels via webContents.capturePage — the exact paint the user
// sees, so boxes/arrows/borders can't be lost the way a style-inlined DOM clone
// could.
import { useState } from 'react';
import { IconArrowsMaximize, IconCheck, IconCopy, IconCopyOff } from '@tabler/icons-react';
import DiagramLightbox from './DiagramLightbox';
import { ipc } from '../lib/ipc';

export function DiagramWidget({ html, title }: { html: string; title?: string }) {
  const [showLarge, setShowLarge] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [cardRef, setCardRef] = useState<HTMLDivElement | null>(null);

  const copyPng = async () => {
    if (!cardRef) return;
    setCopied(false);
    setCopyError('');
    const rect = cardRef.getBoundingClientRect();
    const res = await ipc.copyRegionToClipboard({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    if (res.ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      setCopyError(res.error ?? 'Copy failed');
      window.setTimeout(() => setCopyError(''), 2500);
    }
  };

  const pill = [
    'flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium transition',
    'bg-white/8 text-white/70 hover:bg-white/14 hover:text-white/90',
    'dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90',
  ].join(' ');

  return (
    <div
      ref={setCardRef}
      className="my-2 w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.03] dark:border-neutral-900/10 dark:bg-neutral-900/[0.03]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/8 px-3 py-1.5 dark:border-neutral-900/8">
        <span className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.06em] text-white/45 dark:text-neutral-900/50">
          {title || 'Diagram'}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setShowLarge(true)}
            title="View large"
            className={pill}
          >
            <IconArrowsMaximize size={12} stroke={2} />
            View large
          </button>
          <button
            type="button"
            onClick={() => void copyPng()}
            title={copyError || 'Copy as a PNG image'}
            className={[
              'flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium transition',
              copied
                ? 'bg-accent/15 text-accent'
                : copyError
                  ? 'bg-rose-500/15 text-rose-500 dark:text-rose-700'
                  : pill,
            ].join(' ')}
          >
            {copied ? <IconCheck size={12} stroke={2} /> : copyError ? <IconCopyOff size={12} stroke={2} /> : <IconCopy size={12} stroke={2} />}
            {copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy as PNG'}
          </button>
        </span>
      </div>
      <div className="spirit-diagram overflow-x-auto px-3 py-2.5">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {showLarge && (
        <DiagramLightbox title={title || 'Diagram'} onClose={() => setShowLarge(false)}>
          <div className="spirit-diagram" dangerouslySetInnerHTML={{ __html: html }} />
        </DiagramLightbox>
      )}
    </div>
  );
}