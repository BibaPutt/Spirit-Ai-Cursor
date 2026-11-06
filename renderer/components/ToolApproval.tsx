import { motion } from 'framer-motion';
import type { ToolApprovalRequest } from '../../electron/types';

type Props = {
  request: ToolApprovalRequest;
  onDecide: (id: string, approved: boolean) => void;
};

function argSummary(args: Record<string, unknown>): string | null {
  if (args.url) return String(args.url);
  if (args.text) {
    const t = String(args.text);
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }
  if (args.path) return String(args.path);
  if (args.suggested_name) return String(args.suggested_name);
  return null;
}

export function ToolApproval({ request, onDecide }: Props) {
  const detail = argSummary(request.args);
  return (
    <motion.div
      initial={{ opacity: 0, height: 0, y: -4 }}
      animate={{ opacity: 1, height: 'auto', y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="overflow-hidden"
    >
      <div
        className={[
          'mb-2 flex items-center gap-2 rounded-lg border px-3 py-2',
          'border-accent/30 bg-accent/10',
        ].join(' ')}
      >
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/25">
          <svg viewBox="0 0 14 14" className="h-3 w-3 text-accent" fill="none">
            <path
              d="M7 1.5c-3 0-5.5 2.5-5.5 5.5S4 12.5 7 12.5s5.5-2.5 5.5-5.5c0-1.4-.5-2.7-1.4-3.7"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <path d="M7 5v3M7 10v.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-white dark:text-neutral-900">
            {request.label}
            <span className="ml-2 font-normal text-white/55 dark:text-neutral-900/55">
              needs your OK
            </span>
          </div>
          {detail && (
            <div className="truncate text-[11px] text-white/55 dark:text-neutral-900/55" title={detail}>
              {detail}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDecide(request.id, false)}
          aria-label="Deny"
          className="rounded-md border border-rose-400/30 bg-rose-500/10 p-1.5 text-rose-300 transition hover:bg-rose-500/20 hover:text-rose-200 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-600 dark:hover:bg-rose-500/25"
        >
          <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onDecide(request.id, true)}
          aria-label="Approve"
          className="rounded-md border border-accent/40 bg-accent/15 p-1.5 text-accent transition hover:bg-accent/30"
        >
          <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
            <path
              d="M2.5 7.2l3 3 6.2-6.4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </motion.div>
  );
}
