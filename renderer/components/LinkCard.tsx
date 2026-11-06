import { useState } from 'react';
import { motion } from 'framer-motion';
import { ipc } from '../lib/ipc';
import type { LinkMeta } from '../../electron/types';

type Props = {
  meta: LinkMeta;
  index: number;
};

export function LinkCard({ meta, index }: Props) {
  const [imgOk, setImgOk] = useState(true);
  const title = meta.title || meta.siteName || meta.host;

  return (
    <motion.button
      type="button"
      onClick={() => void ipc.openExternal(meta.url)}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut', delay: index * 0.04 }}
      className={[
        'group flex w-full items-stretch gap-3 overflow-hidden rounded-xl border p-2 text-left transition',
        'border-white/8 bg-white/4 hover:border-white/14 hover:bg-white/8',
        'dark:border-neutral-900/10 dark:bg-neutral-900/4 dark:hover:border-neutral-900/18 dark:hover:bg-neutral-900/8',
      ].join(' ')}
    >
      {meta.image && imgOk ? (
        <img
          src={meta.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImgOk(false)}
          className="h-14 w-14 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div
          className={[
            'flex h-14 w-14 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold uppercase tracking-wide',
            'bg-white/8 text-white/55',
            'dark:bg-neutral-900/10 dark:text-neutral-900/55',
          ].join(' ')}
        >
          {meta.host.slice(0, 2)}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-0.5">
        <div className="truncate text-[13px] font-medium leading-tight text-white/95 dark:text-neutral-900/95">
          {title}
        </div>
        {meta.description && (
          <div className="line-clamp-2 text-[11.5px] leading-snug text-white/55 dark:text-neutral-900/55">
            {meta.description}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-white/40 dark:text-neutral-900/45">
          <span className="truncate">{meta.host}</span>
          <span className="opacity-0 transition group-hover:opacity-100">↗</span>
        </div>
      </div>
    </motion.button>
  );
}
