import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconPhoto,
  IconX,
  IconWorld,
} from '@tabler/icons-react';
import { ipc } from '../lib/ipc';
import { faviconUrl, hostOf } from '../lib/favicon';
import type { WebImage } from '../../electron/types';

type Props = {
  images: WebImage[];
  index: number;
  onClose: () => void;
};

// Full-screen lightbox for a web image from the answer's image row. Opens from
// the row (or from the image menu), supports ←/→ arrow-key navigation that
// wraps, Escape / backdrop-click to close, and shows the image's source page
// with its favicon underneath. Portaled to <body> so it covers the whole
// overlay window, and marked data-spirit-ui so the custom cursor stays a hand.
export default function ImageLightbox({ images, index, onClose }: Props) {
  const count = images.length;
  const [i, setI] = useState(index);
  const [imgOk, setImgOk] = useState(true);
  // Some sources (e.g. Openverse originals) hotlink-protect the full-size
  // `url` while serving a stable proxied thumbnail. Start with the full url;
  // if it fails to load, fall back to the thumb so the lightbox never shows
  // an empty black screen.
  const [useThumb, setUseThumb] = useState(false);

  useEffect(() => {
    setI(index);
  }, [index]);

  useEffect(() => {
    setImgOk(true);
    setUseThumb(false);
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        setI((v) => (v + 1) % count);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        setI((v) => (v - 1 + count) % count);
      } else if (e.key === 'Escape') {
        // Capture-phase stopPropagation so Escape closes only the lightbox —
        // it must never reach the input and cancel the whole query.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [count, onClose]);

  if (count === 0) return null;
  const img = images[i] ?? images[0]!;
  const src = useThumb ? (img.thumb ?? img.url) : img.url;
  const host = hostOf(img.source);
  const favicon = faviconUrl(img.source);

  return createPortal(
    <div
      data-spirit-ui
      className="fixed inset-0 z-[9997] flex items-center justify-center bg-black/75"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        onClick={onClose}
        title="Close (Esc)"
        className="absolute right-4 top-4 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 backdrop-blur-md transition-colors hover:bg-white/25 hover:text-white dark:border-neutral-900/25 dark:bg-neutral-900/60 dark:text-neutral-200"
      >
        <IconX size={16} stroke={2} />
      </button>

      <div className="relative flex max-h-[92vh] w-full max-w-[90vw] flex-col items-center gap-3 px-4 py-4">
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {imgOk ? (
            <img
              src={src}
              alt={img.title || 'Web image'}
              referrerPolicy="no-referrer"
              onError={() => {
                if (!useThumb && img.thumb && img.thumb !== img.url) {
                  setUseThumb(true);
                } else {
                  setImgOk(false);
                }
              }}
              className="max-h-[72vh] max-w-[86vw] rounded-lg object-contain shadow-glass"
            />
          ) : (
            <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-white/40">
              <IconPhoto size={40} stroke={1.5} />
            </div>
          )}

          {count > 1 && (
            <>
              <button
                onClick={() => setI((v) => (v - 1 + count) % count)}
                title="Previous (←)"
                className="absolute left-1 top-1/2 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 backdrop-blur-md transition-colors hover:bg-white/25 hover:text-white dark:border-neutral-900/25 dark:bg-neutral-900/60 dark:text-neutral-200"
              >
                <IconChevronLeft size={18} stroke={2} />
              </button>
              <button
                onClick={() => setI((v) => (v + 1) % count)}
                title="Next (→)"
                className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 backdrop-blur-md transition-colors hover:bg-white/25 hover:text-white dark:border-neutral-900/25 dark:bg-neutral-900/60 dark:text-neutral-200"
              >
                <IconChevronRight size={18} stroke={2} />
              </button>
            </>
          )}
        </div>

        <div className="flex w-full max-w-[86vw] items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {favicon ? (
              <img
                src={favicon}
                alt=""
                referrerPolicy="no-referrer"
                className="h-4 w-4 shrink-0 rounded-sm"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : null}
            {!favicon && <IconWorld size={16} stroke={1.5} className="shrink-0 text-white/60" />}
            <span className="truncate text-[11px] font-medium text-white/70" title={host}>
              {host || 'Unknown source'}
            </span>
            <button
              onClick={() => void ipc.openExternal(img.source)}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80 backdrop-blur-md transition-colors hover:bg-white/25 hover:text-white dark:border-neutral-900/25 dark:bg-neutral-900/60 dark:text-neutral-200"
            >
              <IconExternalLink size={12} stroke={2} />
              View source
            </button>
          </div>
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-white/60">
            {i + 1} / {count}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
