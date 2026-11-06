import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Loader2, X } from 'lucide-react';import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ToolActivityRow } from '../hooks/useLLMQuery';
import { chainLabelFor, currentChainLabel } from '../lib/chainLabels';
import { cn } from '../lib/utils';
import { AgentStatus } from './AgentStatus';
import { LatexInline } from './LatexInline';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtItem,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
} from './prompt-kit/chain-of-thought';
import { Tool } from './prompt-kit/tool';

type Props = {
  activities: ToolActivityRow[];
  reasoning: string;
  busy: boolean;
  hasResponse: boolean;
  // Frozen round-trip seconds, set when the final answer lands. Shown as
  // "thought for 4.4s" next to the header once done.
  elapsedSecs?: number | null;
};

// Minimal status dot: spinning ring while running, tiny check when done,
// rose ✕ on error. No numbered badges, no pills.
function StepDot({ row }: { row: ToolActivityRow }) {
  if (row.status === 'running') {
    return <Loader2 className="size-3 animate-spin text-[rgb(var(--spirit-accent-rgb))]" />;
  }
  if (row.status === 'error') {
    return <X className="size-3 text-rose-500/90" strokeWidth={2.5} />;
  }
  return <Check className="size-3 text-emerald-500/80 dark:text-emerald-600/80" strokeWidth={2.5} />;
}

function activityState(row: ToolActivityRow): ToolPartState {
  if (row.status === 'running') return 'input-streaming';
  if (row.status === 'error') return 'output-error';
  return 'output-available';
}

function argsObject(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return undefined;
}

// Long thinking dumps arrive as one giant unbroken line. Cut them into short
// paragraphs (sentence-aware) so reasoning reads as compact blocks.
const REASONING_PARAGRAPH_MAX = 900;
function chunkReasoning(text: string): string[] {
  const out: string[] = [];
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const push = (p: string) => {
    if (p.length <= REASONING_PARAGRAPH_MAX) {
      out.push(p);
      return;
    }
    let rest = p;
    while (rest.length > REASONING_PARAGRAPH_MAX) {
      const window = rest.slice(0, REASONING_PARAGRAPH_MAX);
      let cut = window.lastIndexOf('. ');
      if (cut < REASONING_PARAGRAPH_MAX * 0.5) cut = window.lastIndexOf(' ');
      if (cut < 0) cut = REASONING_PARAGRAPH_MAX;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
    if (rest.trim()) out.push(rest.trim());
  };
  if (paras.length === 0) return text ? [text] : [];
  for (const p of paras) push(p);
  return out;
}

export function ChainPanel({ activities, reasoning, busy, hasResponse, elapsedSecs = null }: Props) {
  const { t } = useTranslation();
  const stepsCount = activities.length;
  const hasReasoning = reasoning.trim().length > 0;
  // Pure thinking: no reasoning streamed, no tool steps yet — fall back to the
  // classic rotating status line instead of nesting a "Thinking" button inside
  // a "Thinking" header.
  const thinking = busy && stepsCount === 0 && !hasReasoning;

  // Always starts collapsed (single line). Auto-collapses the moment the
  // answer starts streaming; expanding is a manual choice. ALL hooks live
  // above every early return — hooks after a conditional return crash React
  // (#310) the moment the panel flips between empty and non-empty.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hasResponse) setOpen(false);
  }, [hasResponse]);

  // Expanded height: the panel grows with its content up to a FIXED max
  // (460px) — opening inner steps expands it further instead of squeezing
  // into the first-measured size. Extra content beyond the cap scrolls
  // inside, so the prompt box never grows unbounded. Closing resets.
  const FIXED_MAX_H = 460;
  const rootRef = useRef<HTMLDivElement>(null);
  const [lockedH, setLockedH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (!open) {
      setLockedH(null);
      return;
    }
    const measure = () => {
      const h = Math.min(el.getBoundingClientRect().height, FIXED_MAX_H);
      setLockedH((prev) => (prev === h ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, stepsCount, hasReasoning]);

  if (!busy && stepsCount === 0 && !hasReasoning) return null;
  if (thinking) return <AgentStatus />;

  // Header shows WHAT the AI is doing, not a raw step count. Time appears
  // ONLY as a frozen total once done — never a live ticking timer.
  const currentLabel =
    currentChainLabel(activities) ?? (hasReasoning ? t('chain.reasoning') : t('chain.thinkingDots'));
  const timeSuffix =
    !busy && elapsedSecs !== null && elapsedSecs !== undefined && Number.isFinite(elapsedSecs)
      ? ` · thought for ${elapsedSecs.toFixed(1)}s`
      : '';
  const title = `${currentLabel}${timeSuffix}`;

  return (
    <div
      ref={rootRef}
      className="mb-1.5 flex min-h-0 flex-col overflow-hidden"
      style={open && lockedH ? { maxHeight: lockedH } : undefined}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-white/5 dark:hover:bg-neutral-900/5"
      >
        {busy ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-[rgb(var(--spirit-accent-rgb))]" />
        ) : (
          <Check className="size-3 shrink-0 text-emerald-500/80 dark:text-emerald-600/80" strokeWidth={2.5} />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white/55 dark:text-neutral-900/55">
          {title}
        </span>
        <ChevronRight
          className={cn('size-3 shrink-0 text-white/30 transition-transform dark:text-neutral-900/30', open && 'rotate-90')}
        />
      </button>

      {open && (
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-1">
          {hasReasoning && (
            /* Reasoning as quiet paragraphs under the header — no nested
               collapsible, no duplication. */
            <div className="space-y-1 py-0.5">
              {chunkReasoning(reasoning).map((chunk, i) => (
                <p
                  key={i}
                  className="whitespace-pre-wrap text-[11px] leading-relaxed text-white/45 dark:text-neutral-900/45"
                >
                  <LatexInline text={chunk} />
                </p>
              ))}
            </div>
          )}

          {stepsCount > 0 && (
            <ChainOfThought className="mt-0.5">
              {activities.map((a) => (
                <ChainOfThoughtStep key={a.id}>
                  <ChainOfThoughtTrigger leftIcon={<StepDot row={a} />}>
                    {chainLabelFor(a.name, a.args, a.label)}
                  </ChainOfThoughtTrigger>
                  <ChainOfThoughtContent>
                    {a.summary && a.status !== 'running' && <ChainOfThoughtItem>{a.summary}</ChainOfThoughtItem>}
                    <Tool
                      toolPart={{
                        type: a.name,
                        state: activityState(a),
                        input: argsObject(a.args),
                        output: a.status === 'done' && a.summary ? { result: a.summary } : undefined,
                        errorText: a.status === 'error' ? a.summary : undefined,
                        toolCallId: a.id,
                      }}
                    />
                  </ChainOfThoughtContent>
                </ChainOfThoughtStep>
              ))}
            </ChainOfThought>
          )}

          {!hasReasoning && stepsCount === 0 && !busy && (
            <p className="py-0.5 text-[11px] text-white/40 dark:text-neutral-900/40">{t('chain.done')}</p>
          )}
        </div>
      )}
    </div>
  );
}

type ToolPartState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';