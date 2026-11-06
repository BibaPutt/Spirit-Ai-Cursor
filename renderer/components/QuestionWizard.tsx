// The `[QUESTIONS]` wizard shell: the model only fills in the question texts,
// answer types and options; this component owns the multi-step flow (progress
// "Question X of N", next/back/skip, per-question validation, a confirmation
// screen) and submits the finished answers back to the AI as a follow-up. In
// audio mode each question is read aloud as it is shown and the full Q&A is
// read on the confirmation screen. TTS only ever sees question/answer TEXT —
// never tags or markup.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UiQuestion, UiQuestionSet } from '../../electron/types';
import { useTTS } from '../hooks/useTTS';
import { stringifyValue } from './CustomUi';
import { LatexInline } from './LatexInline';
import { Markdown } from './Markdown';
import { MermaidDiagram } from './MermaidDiagram';

type Props = {
  set: UiQuestionSet;
  onSubmit: (prompt: string) => void;
  audioMode?: boolean;
};

const CARD =
  'rounded-lg border border-white/10 bg-white/5 dark:border-neutral-900/10 dark:bg-neutral-900/5';
const TEXT = 'text-white/85 dark:text-neutral-900/85';
const MUTED = 'text-white/50 dark:text-neutral-900/50';
const INPUT =
  'w-full min-w-0 rounded-md border border-white/12 bg-white/8 px-2 py-1 text-[12.5px] text-white/90 outline-none transition placeholder:text-white/30 focus:border-accent/60 dark:border-neutral-900/15 dark:bg-neutral-900/8 dark:text-neutral-900/90 dark:placeholder:text-neutral-900/30';

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

// Annotation tags ([POINT:x,y:label], [BOX:...:label], [ARROW:...:label])
// carry no meaning inside question pills — collapse to the human label so
// raw coordinates never show as text.
const ANNOTATION_TAG_RE = /\[(?:POINT|BOX|ARROW):[^\]]*:([^\]:]+)\]/gi;

export function stripAnnotationLabels(text: string): string {
  return String(text ?? '').replace(ANNOTATION_TAG_RE, '$1');
}

const MERMAID_FENCE_RE = /```mermaid\n([\s\S]*?)```/i;

// Rich question/option text: annotation tags → labels, ```mermaid fences →
// real diagrams, everything else → Markdown (md + LaTeX). Compact mode
// (option pills, native selects) stays inline-safe: labels + math only.
export function RichText({ text, compact = false }: { text: string; compact?: boolean }) {
  const stripped = stripAnnotationLabels(text);
  if (compact) return <LatexInline text={stripped} />;
  const fence = MERMAID_FENCE_RE.exec(stripped);
  if (fence?.[1]?.trim()) {
    const before = stripped.slice(0, fence.index).trim();
    const after = stripped.slice(fence.index + fence[0].length).trim();
    return (
      <div className="min-w-0">
        {before && <Markdown text={before} />}
        <div className="max-h-56 overflow-auto rounded-md border border-white/8 dark:border-neutral-900/10">
          <MermaidDiagram code={fence[1].trim()} />
        </div>
        {after && <Markdown text={after} />}
      </div>
    );
  }
  return <Markdown text={stripped} />;
}

const optionEntries = (q: UiQuestion): Array<{ label: string; value: string }> =>
  (q.options ?? []).map((o, i) =>
    typeof o === 'string' ? { label: o, value: o } : { label: o?.label ?? '', value: o?.value ?? String(i) },
  );

function answerLabel(q: UiQuestion, v: unknown): string {
  if (isEmpty(v)) return '—';
  if (Array.isArray(v)) {
    const entries = optionEntries(q);
    return v.map((x) => entries.find((e) => e.value === String(x))?.label ?? stringifyValue(x)).join(', ');
  }
  const entries = optionEntries(q);
  if (q.type === 'radio' || q.type === 'select') {
    return entries.find((e) => e.value === String(v))?.label ?? stringifyValue(v);
  }
  if (q.type === 'checkbox' || q.type === 'toggle') return stringifyValue(v);
  return stringifyValue(v);
}

export function QuestionWizard({ set, onSubmit, audioMode = false }: Props) {
  const questions = useMemo(() => (set.questions ?? []).filter((q) => q && typeof q.q === 'string' && q.q.trim()), [set]);
  const tts = useTTS();
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, unknown>>({});
  const [review, setReview] = useState(false);
  const spokeReviewRef = useRef(false);

  // Fresh question set (new answer, same slot) must never show the previous
  // set's position/answers — reset all progress when `set` changes.
  useEffect(() => {
    setIdx(0);
    setAnswers({});
    setReview(false);
    spokeReviewRef.current = false;
  }, [set]);

  const question = questions[Math.min(idx, questions.length - 1)];
  const isLast = idx === questions.length - 1;

  const setAnswer = useCallback((i: number, v: unknown) => {
    setAnswers((prev) => ({ ...prev, [i]: v }));
  }, []);

  const q = question;
  const val = q ? answers[idx] ?? q.default : undefined;
  const qEmpty = q ? isEmpty(val) : false;
  const nextDisabled = !!q?.required && qEmpty;

  const speakText = useCallback(
    (text: string) => {
      if (!audioMode) return;
      void tts.speak(text);
    },
    [audioMode, tts],
  );

  useEffect(() => {
    if (!questions.length || review) return;
    const cur = questions[idx];
    if (!cur) return;
    speakText(`Question ${idx + 1} of ${questions.length}. ${cur.q}`);
  }, [idx, review, questions, speakText]);

  useEffect(() => {
    if (!review || spokeReviewRef.current) return;
    spokeReviewRef.current = true;
    const lines = questions.map((cur, i) => `${i + 1}. ${cur.q} ${answerLabel(cur, answers[i] ?? cur.default)}`);
    speakText(`Your answers. ${lines.join('. ')}`);
  }, [review, questions, answers, speakText]);

  const goNext = useCallback(() => {
    if (isLast) setReview(true);
    else setIdx((i) => i + 1);
  }, [isLast]);

  const goBack = useCallback(() => {
    if (review) setReview(false);
    else if (idx > 0) setIdx((i) => i - 1);
  }, [idx, review]);

  const reset = useCallback(() => {
    spokeReviewRef.current = false;
    setAnswers({});
    setReview(false);
    setIdx(0);
  }, []);

  const finish = useCallback(() => {
    const body = questions
      .map((cur, i) => `Q${i + 1}: ${cur.q}\nA${i + 1}: ${answerLabel(cur, answers[i] ?? cur.default)}`)
      .join('\n');
    onSubmit(`Your answers to the questions you asked:\n\n${body}`);
  }, [questions, answers, onSubmit]);

  if (questions.length === 0) return null;

  const navBtn =
    'rounded-full px-3 py-1 text-[11.5px] font-medium transition disabled:opacity-40';

  return (
    <div className={`${CARD} my-1.5 w-full min-w-0 p-2.5`}>
      <div className="mb-2">
        {set.title && (
          <p className="text-[12px] font-semibold text-white/90 dark:text-neutral-900/90">{set.title}</p>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10 dark:bg-neutral-900/10">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{
                width: `${review ? 100 : ((idx + (qEmpty ? 0 : 1)) / questions.length) * 100}%`,
              }}
            />
          </div>
          <span className={`shrink-0 text-[10px] font-medium tabular-nums ${MUTED}`}>
            {review ? `Confirmation` : `Question ${idx + 1} of ${questions.length}`}
          </span>
        </div>
      </div>

      {review ? (
        <div className="space-y-2">
          <div className="space-y-1.5">
            {questions.map((cur, i) => (
              <div key={i} className="rounded-md bg-white/4 px-2.5 py-1.5 dark:bg-neutral-900/4">
                <div className={`${TEXT} text-[11.5px] font-medium`}>
                  {i + 1}. <RichText text={cur.q} />
                </div>
                <p className={`${MUTED} text-[11.5px]`}>{answerLabel(cur, answers[i] ?? cur.default)}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <button type="button" onClick={reset} className={`${navBtn} bg-white/8 text-white/70 hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90`}>
              Start over
            </button>
            <button type="button" onClick={goBack} className={`${navBtn} bg-white/8 text-white/70 hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90`}>
              Back
            </button>
            <button type="button" onClick={finish} className={`${navBtn} bg-accent text-white hover:brightness-110 dark:text-neutral-900`}>
              Finish
            </button>
          </div>
        </div>
      ) : (
        q && (
          <>
            <Question q={q} value={val} onChange={(v) => setAnswer(idx, v)} />
            <div className="mt-2 flex items-center justify-between gap-1.5">
              {idx > 0 ? (
                <button type="button" onClick={goBack} className={`${navBtn} bg-white/8 text-white/70 hover:bg-white/14 hover:text-white/90 dark:bg-neutral-900/8 dark:text-neutral-900/70 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900/90`}>
                  Back
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-1.5">
                {!q.required && !isLast && (
                  <button
                    type="button"
                    onClick={goNext}
                    className={`${navBtn} text-white/50 hover:text-white/90 dark:text-neutral-900/50 dark:hover:text-neutral-900/90`}
                  >
                    Skip
                  </button>
                )}
                {!q.required && isLast && !review && (
                  <button
                    type="button"
                    onClick={goNext}
                    className={`${navBtn} text-white/50 hover:text-white/90 dark:text-neutral-900/50 dark:hover:text-neutral-900/90`}
                  >
                    Skip
                  </button>
                )}
                <button
                  type="button"
                  onClick={goNext}
                  disabled={nextDisabled}
                  className={`${navBtn} bg-accent text-white hover:brightness-110 disabled:opacity-40 dark:text-neutral-900`}
                >
                  {isLast ? 'Review answers' : 'Next'}
                </button>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}

function Question({
  q,
  value,
  onChange,
}: {
  q: UiQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const type = q.type ?? 'text';
  const label = q.q;
  const required = q.required;

  const control = (() => {
    switch (type) {
      case 'radio':
        return (
          <div className="space-y-1">
            {optionEntries(q).map((o, i) => (
              <label key={i} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  className="h-3.5 w-3.5 accent-accent"
                  checked={String(value ?? '') === o.value}
                  onChange={() => onChange(o.value)}
                />
                <span className={`${TEXT} text-[12px]`}><RichText text={o.label} compact /></span>
              </label>
            ))}
          </div>
        );
      case 'select':
        return (
          <select
            className={`${INPUT} appearance-none`}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          >
            {!required && <option value="" />}
            {optionEntries(q).map((o, i) => (
              <option key={i} value={o.value}>
                {stripAnnotationLabels(o.label)}
              </option>
            ))}
          </select>
        );
      case 'multi':
        return (
          <div className="space-y-1">
            {optionEntries(q).map((o, i) => {
              const cur = (Array.isArray(value) ? value : []).map(String);
              return (
                <label key={i} className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={cur.includes(o.value)}
                    onChange={(e) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.add(o.value);
                      else next.delete(o.value);
                      onChange([...next]);
                    }}
                  />
                  <span className={`${TEXT} text-[12px]`}><RichText text={o.label} compact /></span>
                </label>
              );
            })}
          </div>
        );
      case 'checkbox':
        return (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className={`${TEXT} text-[12px]`}>{q.placeholder ?? 'Yes'}</span>
          </label>
        );
      case 'toggle':
        return (
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(value)}
            onClick={() => onChange(!value)}
            className={`flex h-[18px] w-[32px] items-center rounded-full p-[2px] transition ${value ? 'bg-accent' : 'bg-white/15 dark:bg-neutral-900/15'}`}
          >
            <span
              className={`h-[14px] w-[14px] rounded-full bg-white shadow transition-transform ${value ? 'translate-x-[14px]' : 'translate-x-0'}`}
            />
          </button>
        );
      case 'slider':
        return (
          <div className="flex items-center gap-2">
            <input
              type="range"
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 dark:bg-neutral-900/15"
              style={{ accentColor: 'rgb(var(--spirit-accent-rgb))' }}
              min={q.min ?? 0}
              max={q.max ?? 100}
              step={q.step ?? 1}
              value={Number(value ?? q.default ?? q.min ?? 0)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <span className="w-8 shrink-0 text-right text-[11.5px] font-semibold tabular-nums text-accent">
              {Number(value ?? q.default ?? q.min ?? 0)}
            </span>
          </div>
        );
      case 'textarea':
        return (
          <textarea
            className={`${INPUT} min-h-[54px] resize-y`}
            value={String(value ?? '')}
            placeholder={q.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'number':
        return (
          <input
            type="number"
            className={INPUT}
            value={String(value ?? '')}
            placeholder={q.placeholder}
            min={q.min}
            max={q.max}
            step={q.step}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'date':
        return (
          <input
            type="date"
            className={INPUT}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      default:
        return (
          <input
            type="text"
            className={INPUT}
            value={String(value ?? '')}
            placeholder={q.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  })();

  return (
    <div>
      <div className={`${TEXT} mb-1.5 text-[12.5px] font-medium leading-snug`}>
        <RichText text={label} />
        {required && <span className="ml-0.5 text-accent">*</span>}
      </div>
      {control}
    </div>
  );
}
