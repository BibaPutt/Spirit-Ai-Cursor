import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '@tabler/icons-react';

type Props = {
  title?: string;
  onClose: () => void;
  children: ReactNode;
};

// Full-screen "view large" for the diagram widgets (Mermaid + the .dg-* [DIAGRAM]
// cards) — mirrors the image lightbox: portaled to <body> so it covers the whole
// overlay window, Escape / backdrop-click to close (capture-phase stopPropagation
// so Esc never reaches the prompt input and cancels the query), and
// data-spirit-ui so the custom cursor stays a hand. The content is rendered at
// NATURAL size inside a scrollable pane — the inline max-width/height clamping
// that scales diagrams down in the answer card is neutralized by the
// `.spirit-lightbox-content` rules in globals.css.
export default function DiagramLightbox({ title, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  return createPortal(
    <div
      data-spirit-ui
      className="fixed inset-0 z-[9997] flex items-center justify-center bg-black/75 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        onClick={onClose}
        title="Close (Esc)"
        className="absolute right-4 top-4 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 backdrop-blur-md transition-colors hover:bg-white/25 hover:text-white dark:border-neutral-900/25 dark:bg-neutral-900/60 dark:text-neutral-200"
      >
        <IconX size={16} stroke={2} />
      </button>

      <div className="relative flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-white/15 bg-neutral-950/95 shadow-glass dark:border-neutral-900/25 dark:bg-white/95">
        {title ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
            <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-white/60 dark:text-neutral-900/60">
              {title}
            </span>
            <span className="shrink-0 text-[10.5px] font-medium text-white/35 dark:text-neutral-900/40">
              Scroll to see it all
            </span>
          </div>
        ) : null}
        <div className="spirit-lightbox-content min-h-0 flex-1 overflow-auto">
          <div
            className="flex min-w-max items-center justify-center p-5"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}