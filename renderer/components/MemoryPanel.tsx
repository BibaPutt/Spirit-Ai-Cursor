import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ipc } from '../lib/ipc';
import { cn } from '../lib/utils';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';

import type { MemoryItem } from '../../electron/types';

const TAGS = ['all', 'app', 'clipboard', 'selection', 'ocr', 'paint'] as const;

type Props = {
  onBack: () => void;
};

export function MemoryPanel({ onBack }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const confirmClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await ipc.listMemories();
      setItems(all);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // auto-focus edit textarea
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.setSelectionRange(editText.length, editText.length);
    }
  }, [editingId]);

  const filtered = items.filter((item) => {
    if (activeTag !== 'all' && !item.sources.includes(activeTag)) return false;
    if (search && !item.text.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleDelete = async (id: string) => {
    if (confirmDelete === id) {
      await ipc.deleteMemory(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
      setConfirmDelete(null);
    } else {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  };

  const handleStartEdit = (item: MemoryItem) => {
    setEditingId(item.id);
    setEditText(item.text);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editText.trim()) return;
    const trimmed = editText.trim();
    await ipc.updateMemory(editingId, trimmed);
    setItems((prev) => prev.map((i) => (i.id === editingId ? { ...i, text: trimmed, updatedAt: Date.now() } : i)));
    setEditingId(null);
    setEditText('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleClearAll = async () => {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      confirmClearTimerRef.current = setTimeout(() => setConfirmClearAll(false), 3000);
      return;
    }
    if (confirmClearTimerRef.current) clearTimeout(confirmClearTimerRef.current);
    setConfirmClearAll(false);
    await ipc.clearMemories();
    setItems([]);
  };

  return (
    <div className="flex flex-col">
      {/* Header with back button */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[12px] text-white/60 transition hover:text-white dark:text-neutral-900/60 dark:hover:text-neutral-900"
        >
          ← Back
        </button>
        <span className="text-[12px] font-medium text-white dark:text-neutral-900">
          {t('memory.title')}
        </span>
        <button
          onClick={handleClearAll}
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px] font-medium transition',
            confirmClearAll
              ? 'bg-red-500/20 text-red-400'
              : 'text-red-400/70 hover:bg-red-500/10 hover:text-red-400',
          )}
        >
          {confirmClearAll ? t('memory.confirmClearAll') : t('memory.clearAll')}
        </button>
      </div>

      <Separator />

      {/* Search */}
      <div className="px-4 py-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('memory.search')}
          className="w-full rounded-md border border-white/14 bg-black/40 px-2.5 py-1.5 text-[11px] text-white placeholder:text-white/30 focus:border-[rgb(var(--spirit-accent-rgb))]/60 focus:outline-none dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900 dark:placeholder:text-neutral-900/35"
        />
      </div>

      {/* Tag filters */}
      <div className="flex gap-1 px-4 pb-2">
        {TAGS.map((tag) => (
          <button
            key={tag}
            onClick={() => setActiveTag(tag)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium transition',
              activeTag === tag
                ? 'bg-[rgb(var(--spirit-accent-rgb))]/20 text-[rgb(var(--spirit-accent-rgb))]'
                : 'bg-white/5 text-white/50 hover:bg-white/10 dark:bg-neutral-900/10 dark:text-neutral-900/50 dark:hover:bg-neutral-900/15',
            )}
          >
            {t(`memory.tags.${tag}`)}
          </button>
        ))}
      </div>

      <Separator />

      {/* Memory list */}
      <ScrollArea className="max-h-[300px]">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-[11px] text-white/35 dark:text-neutral-900/40">
            {t('memory.empty')}
          </div>
        ) : (
          <div className="divide-y divide-white/5 dark:divide-neutral-900/10">
            {filtered.map((item) => {
              const isEditing = editingId === item.id;
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-2 px-4 py-2 transition hover:bg-white/3 dark:hover:bg-neutral-900/3"
                >
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex flex-col gap-1.5">
                        <textarea
                          ref={editInputRef}
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveEdit(); }
                            if (e.key === 'Escape') handleCancelEdit();
                          }}
                          rows={2}
                          className="w-full resize-none rounded border border-[rgb(var(--spirit-accent-rgb))]/40 bg-black/40 px-2 py-1 text-[11px] text-white focus:outline-none dark:border-neutral-900/30 dark:bg-neutral-900/5 dark:text-neutral-900"
                        />
                        <div className="flex gap-1">
                          <button
                            onClick={handleSaveEdit}
                            className="rounded bg-[rgb(var(--spirit-accent-rgb))]/15 px-2 py-0.5 text-[10px] font-medium text-[rgb(var(--spirit-accent-rgb))] transition hover:bg-[rgb(var(--spirit-accent-rgb))]/25"
                          >
                            {t('memory.saveEdit')}
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="rounded px-2 py-0.5 text-[10px] text-white/40 transition hover:text-white/60 dark:text-neutral-900/40 dark:hover:text-neutral-900/60"
                          >
                            {t('memory.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="truncate text-[11px] text-white/80 dark:text-neutral-900/80">
                          {item.text.length > 80 ? item.text.slice(0, 80) + '…' : item.text}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[9px] text-white/35 dark:text-neutral-900/40">
                          <span>{item.sources.join(', ')}</span>
                          <span>·</span>
                          <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                        </div>
                      </>
                    )}
                  </div>
                  {!isEditing && (
                    <div className="flex shrink-0 gap-0.5">
                      <button
                        onClick={() => handleStartEdit(item)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-white/30 transition hover:bg-white/10 hover:text-white/60 dark:text-neutral-900/30 dark:hover:bg-neutral-900/10 dark:hover:text-neutral-900/60"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => handleDelete(item.id)}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] transition',
                          confirmDelete === item.id
                            ? 'bg-red-500/20 text-red-400'
                            : 'text-white/30 hover:bg-white/10 hover:text-white/60 dark:text-neutral-900/30 dark:hover:bg-neutral-900/10 dark:hover:text-neutral-900/60',
                        )}
                      >
                        {confirmDelete === item.id ? t('memory.confirmDelete') : '✕'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
