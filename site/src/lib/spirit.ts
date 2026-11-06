import { useCallback, useEffect, useRef, useState } from 'react';

export type SpiritPhase = 'idle' | 'typing' | 'thinking' | 'streaming' | 'done';

export type AnswerKpi = { label: string; value: string; delta?: string };
export type AnswerChartRow = { label: string; value: number; display: string; hi?: boolean };
export type AnswerAct = { label: string };

export type AnswerBlock =
  | { type: 'p'; text: string }
  | { type: 'kpis'; items: AnswerKpi[] }
  | { type: 'chart'; title?: string; rows: AnswerChartRow[] }
  | { type: 'note'; text: string }
  | { type: 'annot'; n: number; text: string }
  | { type: 'latex'; tex: string }
  | { type: 'mermaid'; code: string }
  | { type: 'acts'; items: AnswerAct[] };

export type SpiritAnnotation = {
  kind: 'box' | 'chip' | 'arrow';
  target: string;
  label: string;
  n?: number;
};

export type SpiritChipIcon =
  | 'copy'
  | 'save'
  | 'point'
  | 'export'
  | 'list'
  | 'table'
  | 'bulb'
  | 'chart';

export type SpiritRailChip = { label: string; icon?: SpiritChipIcon };

export type SpiritSuggestionChip = { label: string; icon?: SpiritChipIcon };

export type SpiritDemo = {
  id: string;
  prompt: string;
  file?: string;
  steps: string[];
  blocks: AnswerBlock[];
  chips?: SpiritSuggestionChip[];
  followups?: string[];
  rail?: SpiritRailChip[];
  annotations?: SpiritAnnotation[];
  elapsedSecs?: number;
};

export type SpiritSeqState = {
  phase: SpiritPhase;
  promptShown: string;
  stepIndex: number;
  blocksShown: number;
  elapsedSecs: number | null;
};

const TYPE_MS = 36;
const STEP_MS = 560;
const BLOCK_MS = 220;
const DONE_HOLD_MS = 5200;
const PREVIEW_OPEN_EVENT = 'spirit:preview-open';
const PREVIEW_CLOSE_EVENT = 'spirit:preview-close';
const PREVIEW_TOGGLE_EVENT = 'spirit:preview-toggle';

export const SPIRIT_PREVIEW_EVENT = PREVIEW_OPEN_EVENT;
export const SPIRIT_PREVIEW_CLOSE_EVENT = PREVIEW_CLOSE_EVENT;
export const SPIRIT_PREVIEW_TOGGLE_EVENT = PREVIEW_TOGGLE_EVENT;

export function openSpiritPreview() {
  window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT));
}

export function closeSpiritPreview() {
  window.dispatchEvent(new CustomEvent(PREVIEW_CLOSE_EVENT));
}

export function toggleSpiritPreview() {
  window.dispatchEvent(new CustomEvent(PREVIEW_TOGGLE_EVENT));
}

export function useSpiritSequence(
  demo: SpiritDemo | null,
  opts: { auto?: boolean; start?: boolean; onAnnotation?: (a: SpiritAnnotation[]) => void } = {},
): SpiritSeqState & {
  start: () => void;
  reset: () => void;
  run: (next: SpiritDemo) => void;
  done: boolean;
} {
  const { auto = false, start: startOpt = true, onAnnotation } = opts;
  const [state, setState] = useState<SpiritSeqState>({
    phase: 'idle',
    promptShown: '',
    stepIndex: -1,
    blocksShown: 0,
    elapsedSecs: null,
  });
  const timersRef = useRef<number[]>([]);
  const demoRef = useRef<SpiritDemo | null>(demo);
  const onAnnRef = useRef(onAnnotation);
  const runRef = useRef<(d: SpiritDemo) => void>(() => {});
  demoRef.current = demo;
  onAnnRef.current = onAnnotation;

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  }, []);

  const finish = useCallback(
    (d: SpiritDemo) => {
      setState({
        phase: 'done',
        promptShown: d.prompt,
        stepIndex: d.steps.length,
        blocksShown: d.blocks.length,
        elapsedSecs: d.elapsedSecs ?? Number((d.steps.length * 0.56).toFixed(1)),
      });
      if (d.annotations?.length) onAnnRef.current?.(d.annotations);
      if (auto) {
        later(() => {
          const cur = demoRef.current;
          if (cur) {
            onAnnRef.current?.([]);
            setState({
              phase: 'idle',
              promptShown: '',
              stepIndex: -1,
              blocksShown: 0,
              elapsedSecs: null,
            });
            later(() => runRef.current(cur), 400);
          }
        }, DONE_HOLD_MS);
      }
    },
    [auto, later],
  );

  const runInternal = useCallback(
    (d: SpiritDemo) => {
      clearTimers();
      onAnnRef.current?.([]);
      setState({
        phase: 'typing',
        promptShown: '',
        stepIndex: -1,
        blocksShown: 0,
        elapsedSecs: null,
      });

      const chars = [...d.prompt];
      chars.forEach((_, i) => {
        later(() => {
          setState((s) => ({ ...s, promptShown: chars.slice(0, i + 1).join('') }));
        }, TYPE_MS * (i + 1));
      });

      const afterType = TYPE_MS * chars.length + 180;
      later(() => {
        setState((s) => ({ ...s, phase: 'thinking', stepIndex: 0 }));
      }, afterType);

      d.steps.forEach((_, i) => {
        later(() => {
          setState((s) => ({ ...s, stepIndex: i + 1 }));
        }, afterType + STEP_MS * (i + 1));
      });

      const afterThink = afterType + STEP_MS * (d.steps.length + 1) + 120;
      later(() => {
        setState((s) => ({ ...s, phase: 'streaming', blocksShown: 0 }));
      }, afterThink);

      d.blocks.forEach((_, i) => {
        later(() => {
          setState((s) => ({ ...s, blocksShown: i + 1 }));
        }, afterThink + BLOCK_MS * (i + 1));
      });

      const afterStream = afterThink + BLOCK_MS * (d.blocks.length + 1) + 80;
      later(() => finish(d), afterStream);
    },
    [clearTimers, finish, later],
  );

  const start = useCallback(() => {
    const d = demoRef.current;
    if (d) runInternal(d);
  }, [runInternal]);

  const reset = useCallback(() => {
    clearTimers();
    onAnnRef.current?.([]);
    setState({
      phase: 'idle',
      promptShown: '',
      stepIndex: -1,
      blocksShown: 0,
      elapsedSecs: null,
    });
  }, [clearTimers]);

  const run = useCallback(
    (next: SpiritDemo) => {
      demoRef.current = next;
      runInternal(next);
    },
    [runInternal],
  );

  runRef.current = runInternal;

  useEffect(() => {
    if (!startOpt || !demo) return;
    const t = window.setTimeout(() => runInternal(demo), 350);
    return () => window.clearTimeout(t);
  }, [demo?.id, startOpt]);

  useEffect(() => clearTimers, [clearTimers]);

  return {
    ...state,
    start,
    reset,
    run,
    done: state.phase === 'done',
  };
}

export function phaseLabel(phase: SpiritPhase): string {
  switch (phase) {
    case 'typing':
      return 'Listening';
    case 'thinking':
      return 'Thinking';
    case 'streaming':
      return 'Writing';
    case 'done':
      return 'Done';
    default:
      return 'Ready';
  }
}
