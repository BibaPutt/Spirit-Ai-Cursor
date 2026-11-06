'use client';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { cn } from '../../lib/utils';
import { CheckCircle, ChevronDown, Loader2, Settings, XCircle } from 'lucide-react';
import { useState } from 'react';

export type ToolPart = {
  type: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  toolCallId?: string;
  errorText?: string;
};

export type ToolProps = {
  toolPart: ToolPart;
  defaultOpen?: boolean;
  className?: string;
};

const StateIcon = ({ state }: { state: ToolPart['state'] }) => {
  switch (state) {
    case 'input-streaming':
      return <Loader2 className="size-3.5 animate-spin text-[rgb(var(--spirit-accent-rgb))]" />;
    case 'output-available':
      return <CheckCircle className="size-3.5 text-emerald-500 dark:text-emerald-600" />;
    case 'output-error':
      return <XCircle className="size-3.5 text-rose-500 dark:text-rose-600" />;
    default:
      return <Settings className="size-3.5 text-white/45 dark:text-neutral-900/45" />;
  }
};

const StateBadge = ({ state }: { state: ToolPart['state'] }) => {
  const base = 'px-1.5 py-0.5 rounded-full text-[9.5px] font-medium';
  switch (state) {
    case 'input-streaming':
      return (
        <span className={cn(base, 'bg-[rgb(var(--spirit-accent-rgb))]/15 text-[rgb(var(--spirit-accent-rgb))]')}>
          Working
        </span>
      );
    case 'output-available':
      return (
        <span className={cn(base, 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400')}>
          Done
        </span>
      );
    case 'output-error':
      return <span className={cn(base, 'bg-rose-500/15 text-rose-500')}>Error</span>;
    default:
      return <span className={cn(base, 'bg-white/10 text-white/55 dark:bg-neutral-900/10 dark:text-neutral-900/55')}>Ready</span>;
  }
};

const formatValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
};

const Tool = ({ toolPart, defaultOpen = false, className }: ToolProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const { state, input, output, toolCallId } = toolPart;

  return (
    <div className={cn('mt-2 overflow-hidden rounded-md border border-white/10 dark:border-neutral-900/10', className)}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <button className="flex h-auto w-full items-center justify-between gap-2 rounded-b-none bg-transparent px-2 py-1 text-left font-normal transition-colors hover:bg-white/5 dark:hover:bg-neutral-900/5">
            <div className="flex min-w-0 items-center gap-1.5">
              <StateIcon state={state} />
              <span className="truncate font-mono text-[11px] font-medium text-white/85 dark:text-neutral-900/85">
                {toolPart.type}
              </span>
              <StateBadge state={state} />
            </div>
            <ChevronDown className={cn('size-3.5 shrink-0 text-white/45 transition-transform dark:text-neutral-900/45', isOpen && 'rotate-180')} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
          <div className="space-y-2 border-t border-white/8 px-2 py-1.5 dark:border-neutral-900/8">
            {input && Object.keys(input).length > 0 && (
              <div>
                <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-white/45 dark:text-neutral-900/45">
                  Input
                </h4>
                <div className="overflow-hidden rounded border border-white/8 bg-white/5 p-1.5 font-mono text-[10.5px] leading-relaxed text-white/70 dark:border-neutral-900/8 dark:bg-neutral-900/5 dark:text-neutral-900/70">
                  {Object.entries(input).map(([key, value]) => (
                    <div key={key} className="break-all">
                      <span className="text-white/40 dark:text-neutral-900/40">{key}: </span>
                      <span>{formatValue(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {output && (
              <div>
                <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-white/45 dark:text-neutral-900/45">
                  Output
                </h4>
                <div className="overflow-y-auto rounded border border-white/8 bg-white/5 p-1.5 font-mono text-[10.5px] leading-relaxed text-white/70 dark:border-neutral-900/8 dark:bg-neutral-900/5 dark:text-neutral-900/70">
                  <pre className="whitespace-pre-wrap break-all">{formatValue(output)}</pre>
                </div>
              </div>
            )}
            {state === 'output-error' && toolCallId && (
              <div className="text-[10px] text-white/40 dark:text-neutral-900/40">
                <span className="font-mono">Call ID: {toolCallId}</span>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

export { Tool };