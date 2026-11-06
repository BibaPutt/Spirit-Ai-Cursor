import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';

export type NotificationItem = {
  id: string;
  text: string;
  type: 'success' | 'error' | 'info';
  icon?: string;
};

type Props = {
  enabled: boolean;
};

let _addNotification: ((text: string, type?: NotificationItem['type'], icon?: string) => void) | null = null;

export function notify(text: string, type: NotificationItem['type'] = 'success', icon?: string) {
  _addNotification?.(text, type, icon);
}

export function NotificationToast({ enabled }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);

  const add = useCallback(
    (text: string, type: NotificationItem['type'] = 'success', icon?: string) => {
      if (!enabled) return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setItems((prev) => [...prev.slice(-4), { id, text, type, icon }]);
      setTimeout(() => {
        setItems((prev) => prev.filter((i) => i.id !== id));
      }, 3000);
    },
    [enabled],
  );

  useEffect(() => {
    _addNotification = add;
    return () => {
      _addNotification = null;
    };
  }, [add]);

  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-[10000] flex -translate-x-1/2 flex-col items-center gap-1.5">
      <AnimatePresence>
        {items.map((item) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: -12, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ type: 'spring', damping: 24, stiffness: 400, mass: 0.7 }}
            className={cn(
              'pointer-events-auto flex items-center gap-2 rounded-full px-3.5 py-1.5 shadow-glass backdrop-blur-xl',
              'border border-white/10',
              item.type === 'success' && 'bg-neutral-800/90 dark:bg-neutral-100/90',
              item.type === 'error' && 'bg-red-950/90 border-red-500/20 dark:bg-red-50/90',
              item.type === 'info' && 'bg-neutral-800/90 dark:bg-neutral-100/90',
            )}
          >
            <span className="text-[12px]">
              {item.icon ?? (item.type === 'success' ? '✓' : item.type === 'error' ? '✗' : '●')}
            </span>
            <span
              className={cn(
                'text-[11px] font-medium',
                item.type === 'success' && 'text-white/80 dark:text-neutral-900/80',
                item.type === 'error' && 'text-red-300 dark:text-red-600',
                item.type === 'info' && 'text-white/70 dark:text-neutral-900/70',
              )}
            >
              {item.text}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
