import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { popTransition, popVariants } from '../lib/animations';
import { ipc } from '../lib/ipc';
import { ScrollArrows } from './ScrollArrows';

import type { MemoryItem } from '../../electron/types';

const TAG_LABELS: Record<string, string> = {
  app: 'App',
  clipboard: 'Clipboard',
  selection: 'Selection',
  ocr: 'OCR',
  paint: 'Paint',
};

const CONFIRM_MS = 3000;

type Props = {
  onClose: () => void;
};

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

const CHIP_CLS = [
  'rounded-full border px-2.5 py-1 text-[11px] transition',
  'border-white/12 text-white/60 hover:text-white',
  'dark:border-neutral-900/12 dark:text-neutral-900/55 dark:hover:text-neutral-900',
].join(' ');
const CHIP_ACTIVE_CLS = [
  'rounded-full border px-2.5 py-1 text-[11px] transition',
  'border-accent/60 bg-accent/15 text-accent',
  'dark:border-accent/50 dark:bg-accent/10 dark:text-accent',
].join(' ');

export function MemoryManager({ onClose }: Props) {
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState('all');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setMemories(await ipc.listMemories());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memory');
      setMemories([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-clear the two-step delete / clear-all confirmations after a timeout.
  useEffect(() => {
    if (!confirmingId) return;
    const t = setTimeout(() => setConfirmingId(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmingId]);
  useEffect(() => {
    if (!confirmingClear) return;
    const t = setTimeout(() => setConfirmingClear(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmingClear]);

  const tags = [
    'all',
    ...Array.from(new Set((memories ?? []).flatMap((m) => m.sources))),
  ];
  const visible = (memories ?? []).filter(
    (m) => activeTag === 'all' || m.sources.includes(activeTag),
  );

  const handleDelete = async (id: string) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setConfirmingId(null);
    try {
      await ipc.deleteMemory(id);
    } catch {
      // Non-fatal for the UI; refresh reflects reality.
    }
    await refresh();
  };

  const handleClear = async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    setConfirmingClear(false);
    try {
      await ipc.clearMemories();
    } catch {
      // Non-fatal.
    }
    await refresh();
  };

  const startEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setDraft(m.text);
  };

  const handleSaveEdit = async (id: string) => {
    setSavingId(id);
    try {
      await ipc.updateMemory(id, draft);
    } catch {
      // Non-fatal.
    }
    setEditingId(null);
    setDraft('');
    setSavingId(null);
    await refresh();
  };

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black/65 pointer-events-auto dark:bg-neutral-900/40"
      data-spirit-ui
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial="hidden"
        animate="visible"
        exit="hidden"
        variants={popVariants}
        transition={popTransition}
        className={[
          'flex h-[560px] w-[640px] max-w-[92vw] max-h-[92vh] flex-col overflow-hidden rounded-2xl border shadow-glass relative',
          'border-white/10 bg-neutral-800',
          'ring-1 ring-inset ring-white/10',
          'dark:border-neutral-900/12 dark:bg-neutral-100 dark:ring-neutral-900/10',
          'before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-2xl',
          'before:bg-gradient-to-r before:from-white/0 before:via-white/15 before:to-white/0',
          'before:pointer-events-none',
        ].join(' ')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-7 py-5 dark:border-neutral-900/10">
          <div className="flex items-center gap-3">
            <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-accent/20">
              <span className="spirit-loader-idle" />
            </span>
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight text-white dark:text-neutral-900">
                Memory
              </h1>
              <p className="text-[11px] text-white/50 dark:text-neutral-900/55">
                What Spirit remembers about you across sessions
                {memories ? ` · ${memories.length} fact${memories.length === 1 ? '' : 's'}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClear}
              disabled={!memories || memories.length === 0}
              className={[
                'rounded-md px-2.5 py-1.5 text-[11px] transition disabled:opacity-40',
                confirmingClear
                  ? 'bg-red-500/20 text-red-400 dark:bg-red-500/15 dark:text-red-600'
                  : 'text-white/60 hover:bg-white/10 hover:text-white dark:text-neutral-900/60 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900',
              ].join(' ')}
            >
              {confirmingClear ? 'Clear all?' : 'Clear all'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white dark:text-neutral-900/60 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900"
            >
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {tags.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-white/8 px-7 py-3 dark:border-neutral-900/8">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(tag)}
                className={activeTag === tag ? CHIP_ACTIVE_CLS : CHIP_CLS}
              >
                {tag === 'all' ? 'All' : TAG_LABELS[tag] ?? tag}
              </button>
            ))}
          </div>
        )}

        <ScrollArrows outerClassName="flex-1 min-h-0" className="h-full overflow-y-auto px-7 py-6">
          {error && (
            <p className="text-[12px] text-red-400 dark:text-red-600">{error}</p>
          )}
          {!error && memories && visible.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-[13px] font-medium text-white/70 dark:text-neutral-900/70">
                {memories.length === 0
                  ? 'Nothing remembered yet.'
                  : 'No memories in this tag.'}
              </p>
              <p className="max-w-[340px] text-[11px] leading-relaxed text-white/45 dark:text-neutral-900/50">
                {memories.length === 0
                  ? 'Spirit stores durable facts you tell it (preferences, plans, details) so future chats build on them. Enable "Context memory" in Settings → Memory to start capturing.'
                  : 'Try another tag.'}
              </p>
            </div>
          )}
          {!memories && !error && (
            <p className="text-[12px] text-white/45 dark:text-neutral-900/50">
              Loading…
            </p>
          )}

          <div className="flex flex-col gap-2.5">
            {visible.map((m) => (
              <div
                key={m.id}
                className="rounded-xl border border-white/8 bg-white/5 p-3.5 dark:border-neutral-900/8 dark:bg-neutral-900/4"
              >
                {editingId === m.id ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={3}
                      autoFocus
                      spellCheck={false}
                      className={[
                        'w-full resize-none rounded-md border bg-black/20 px-2.5 py-2 text-[12px] outline-none transition',
                        'border-white/14 text-white focus:border-accent/60',
                        'dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900 dark:focus:border-accent',
                      ].join(' ')}
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setDraft('');
                        }}
                        className="rounded-md px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white dark:text-neutral-900/60 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingId === m.id || draft.trim().length < 4}
                        onClick={() => void handleSaveEdit(m.id)}
                        className="rounded-md bg-accent/80 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-accent disabled:opacity-40 dark:text-neutral-900"
                      >
                        {savingId === m.id ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-[12.5px] leading-relaxed text-white/85 dark:text-neutral-900/85">
                      {m.text}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <span
                        className={[
                          'rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                          m.attributedTo === 'user'
                            ? 'bg-accent/15 text-accent dark:text-accent'
                            : 'bg-white/8 text-white/50 dark:bg-neutral-900/8 dark:text-neutral-900/55',
                        ].join(' ')}
                      >
                        {m.attributedTo === 'user' ? 'User' : 'Assistant'}
                      </span>
                      {m.sources.map((s) => (
                        <span
                          key={s}
                          className="rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-white/50 dark:border-neutral-900/10 dark:text-neutral-900/55"
                        >
                          {TAG_LABELS[s] ?? s}
                        </span>
                      ))}
                      <span className="text-[10px] text-white/35 dark:text-neutral-900/40">
                        {fmtDate(m.updatedAt)}
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(m)}
                          aria-label="Edit memory"
                          title="Edit memory"
                          className="rounded-md p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white dark:text-neutral-900/50 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900"
                        >
                          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                            <path
                              d="M11 2.5l2.5 2.5L5 13.5 2 14l.5-3L11 2.5z"
                              stroke="currentColor"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(m.id)}
                          aria-label={confirmingId === m.id ? 'Confirm delete' : 'Delete memory'}
                          title={confirmingId === m.id ? 'Click again to confirm' : 'Delete memory'}
                          className={[
                            'rounded-md p-1.5 transition',
                            confirmingId === m.id
                              ? 'bg-red-500/20 text-red-400 dark:bg-red-500/15 dark:text-red-600'
                              : 'text-white/50 hover:bg-white/10 hover:text-red-400 dark:text-neutral-900/50 dark:hover:bg-neutral-900/8 dark:hover:text-red-600',
                          ].join(' ')}
                        >
                          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                            <path
                              d="M2.5 4h11M6 4V2.5h4V4M3.5 4l.8 9.5h7.4l.8-9.5M6.5 7v4M9.5 7v4"
                              stroke="currentColor"
                              strokeWidth="1.3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </ScrollArrows>
      </motion.div>
    </div>
  );
}
