import { memo, useState } from 'react';
import { IconExternalLink, IconPhoto, IconZoomIn } from '@tabler/icons-react';
import { ipc } from '../lib/ipc';
import type { WebImage } from '../../electron/types';
import ImageLightbox from './ImageLightbox';
import { ScrollArrows } from './ScrollArrows';

type Props = {
  images: WebImage[];
};

// One horizontal scrollable row of web images shown at the top of the answer
// whenever the run produced images. Click a thumbnail to open it in the
// lightbox; hover a tile for its two actions: fullscreen (lightbox) and open
// the source page in the browser.
export const WebImagesRow = memo(function WebImagesRow({ images }: Props) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (images.length === 0) return null;

  return (
    <>
      <ScrollArrows horizontal className="-mx-0.5 flex gap-1.5 overflow-x-auto px-0.5 pb-1.5 pt-0.5">
        {images.map((image, i) => (
          <WebImageTile
            key={`${image.url}-${i}`}
            image={image}
            onOpen={() => setLightboxIndex(i)}
          />
        ))}
      </ScrollArrows>

      {lightboxIndex !== null && (
        <ImageLightbox
          images={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
});

function WebImageTile({
  image,
  onOpen,
}: {
  image: WebImage;
  onOpen: () => void;
}) {
  const [imgOk, setImgOk] = useState(true);

  return (
    <button
      onClick={onOpen}
      title={image.title || 'Open image'}
      className="group relative h-16 w-24 shrink-0 cursor-pointer overflow-hidden rounded-md border border-white/10 bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--spirit-accent-rgb))] dark:border-neutral-900/15 dark:bg-neutral-900/10"
    >
      {imgOk ? (
        <img
          src={image.thumb}
          alt={image.title || 'Web image'}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImgOk(false)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-white/35 dark:text-neutral-500">
          <IconPhoto size={18} stroke={1.5} />
        </span>
      )}
      <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/0 transition group-hover:ring-white/20 dark:group-hover:ring-neutral-900/25" />
      <span className="absolute bottom-0.5 right-0.5 hidden items-center gap-1 group-hover:flex">
        <TileButton
          title="Open fullscreen"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <IconZoomIn size={12} stroke={2} />
        </TileButton>
        <TileButton
          title={image.source ? 'Open source page in browser' : 'No source available'}
          disabled={!image.source}
          onClick={(e) => {
            e.stopPropagation();
            if (image.source) void ipc.openExternal(image.source);
          }}
        >
          <IconExternalLink size={12} stroke={2} />
        </TileButton>
      </span>
    </button>
  );
}

function TileButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      aria-label={title}
      title={title}
      aria-disabled={disabled}
      onClick={onClick}
      className={`flex h-4.5 w-4.5 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/90 backdrop-blur transition-colors hover:bg-white/25 hover:text-white ${
        disabled ? 'cursor-default opacity-50' : 'cursor-pointer'
      } dark:border-neutral-900/20 dark:bg-neutral-900/70 dark:text-neutral-200 dark:hover:bg-white/20 dark:hover:text-neutral-900`}
    >
      {children}
    </span>
  );
}
