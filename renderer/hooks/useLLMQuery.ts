import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { TemplateId, UiSegment, UiLiveBlock, LLMCompletion, ScreenAnnotation } from '../../electron/types';

export type LLMState = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

export type ToolActivityRow = {
  id: string;
  name: string;
  label: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
  // The tool-call input (args) main sent at tool start — shown in the step
  // detail when the user expands a Chain-of-Thought step.
  args?: unknown;
};

export type SubmitOptions = {
  web?: boolean;
  templateId?: TemplateId;
  includeClipboard?: boolean;
  // True when the submit came from tapping a suggestion chip: a chip is
  // always a follow-up to the ongoing conversation, never a new task.
  fromChip?: boolean;
};

export function useLLMQuery() {
  const [state, setState] = useState<LLMState>('idle');
  const [response, setResponse] = useState('');
  // Inline AI-generated UI segments ([UI]/[QUESTIONS]/[MERMAID] blocks) that
  // arrive with the authoritative final answer. Empty = plain markdown answer.
  const [uiSegments, setUiSegments] = useState<UiSegment[]>([]);
  // Live placeholder for a [UI]/[QUESTIONS]/[MERMAID] block the AI is still
  // streaming (raw JSON is masked on the main side). Shown as a titled tile;
  // cleared when the authoritative final lands.
  const [uiLive, setUiLive] = useState<UiLiveBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when a run failed AFTER streaming text: the partial answer is kept and
  // the box offers Continue/Retry instead of showing a bare error.
  const [interrupted, setInterrupted] = useState<string | null>(null);
  const [interruptedCode, setInterruptedCode] = useState('unknown');
  // Typed error category from main (network / overloaded / credits / timeout /
  // auth / unknown) so components can tailor the error display per cause.
  const [errorCode, setErrorCode] = useState<string>('unknown');
  const [activities, setActivities] = useState<ToolActivityRow[]>([]);
  // Live chain-of-thought from a reasoning-capable model. Accumulated from
  // `llm:reasoning` deltas; kept after the answer lands so the collapsed panel
  // can still be opened to read it.
  const [reasoning, setReasoning] = useState('');
  // True while a stream is in flight (submitted, not yet done/errored). The
  // box can be hidden while the AI keeps answering in the background; this
  // lets the renderer keep the live response instead of wiping it on hide.
  const [streamActive, setStreamActive] = useState(false);
  const streamActiveRef = useRef(false);
  const responseRef = useRef('');
  const uiSegmentsRef = useRef<UiSegment[]>([]);
  useEffect(() => {
    responseRef.current = response;
  }, [response]);
  useEffect(() => {
    uiSegmentsRef.current = uiSegments;
  }, [uiSegments]);
  // Run identity: main tags every event with the run id it belongs to.
  // Events from a superseded run are dropped so a fresh answer is never
  // polluted by the cancelled run's late chunks.
  const [completion, setCompletion] = useState<LLMCompletion | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const supersededRunIdRef = useRef<string | null>(null);
  const activePromptRef = useRef('');
  const activeWasWebRef = useRef(false);
  const completedRunIdRef = useRef<string | null>(null);
  const completeRun = useCallback((runId: string, text: string, segments: UiSegment[], annotations?: ScreenAnnotation[]) => {
    if (completedRunIdRef.current === runId) return;
    completedRunIdRef.current = runId;
    setCompletion({
      runId,
      prompt: activePromptRef.current,
      wasWeb: activeWasWebRef.current,
      response: text,
      uiSegments: segments,
      annotations: annotations && annotations.length > 0 ? annotations : undefined,
    });
  }, []);
  // App calls this after committing the completion into the transcript:
  // the newest turn must stop hiding behind committedTurnId and get a tick.
  const consumeCompletion = useCallback(() => {
    setCompletion(null);
  }, []);
  useEffect(() => {
    streamActiveRef.current = streamActive;
  });
  // When a submit interrupts a live run, main cancels the old stream and its
  // async loop then broadcasts a trailing `llm:done`. Because that lands AFTER
  // this submit restarted state, swallow exactly one such done so it can't flip
  // the fresh run back to an idle/done latch before its first chunk arrives.
  const swallowTrailingDoneRef = useRef(false);
  // When the authoritative final answer landed (Date.now()). Used by the box
  // to honour the ~2 min result window for answers that completed in the
  // background while the box was hidden — after that a fresh session starts.
  // Round-trip clock for the "thought for Xs" line: stamped on submit,
  // frozen into elapsedSecs when the final answer lands (or the run ends).
  const queryStartRef = useRef<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState<number | null>(null);
  const lastAnswerAtRef = useRef<number | null>(null);

  // Stream chunks arrive at IPC speed (often every few ms per token). Writing
  // each one straight into React state forces a re-render per chunk — the
  // biggest per-token cost in the box. Instead chunks accumulate in a ref and
  // drain into state on a ~50ms interval, cutting renders to ~20fps while the
  // streamed text still feels live.
  const FLUSH_INTERVAL_MS = 50;
  // Holds the LATEST chunk payload (masked text + live block state) until the
  // flush timer drains it. Latest-wins: each chunk carries the FULL masked
  // streamed text for its display position, so the last one is authoritative
  // for that tick — unlike the old delta appends there is nothing to merge.
  // Chunks from a superseded run are dropped at flush time.
  const pendingChunkRef = useRef<{ runId: string; text: string; uiLive: UiLiveBlock | null } | null>(null);
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reasoning deltas accumulate here and flush on the same ~50ms timer as text
  // chunks (reasoning can be very chatty; latest-wins doesn't apply since it's
  // an append stream, so we batch appends instead of one setState per delta).
  const MAX_REASONING_CHARS = 6000;
  const pendingReasoningRef = useRef('');
  const flushPending = useCallback(() => {
    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    const reasoningDelta = pendingReasoningRef.current;
    if (reasoningDelta) {
      pendingReasoningRef.current = '';
      setReasoning((prev) => {
        const next = prev + reasoningDelta;
        return next.length > MAX_REASONING_CHARS ? next.slice(-MAX_REASONING_CHARS) : next;
      });
    }
    const pending = pendingChunkRef.current;
    if (!pending) return;
    pendingChunkRef.current = null;
    if (pending.runId !== activeRunIdRef.current) return;
    setResponse(pending.text);
    setUiLive(pending.uiLive);
    setState((s) => (s === 'loading' || s === 'streaming' ? 'streaming' : s));
  }, []);

  // Client-side stream watchdog: 180s with no chunk/activity/reasoning
  // force-finishes the run locally so a stalled stream can never pin the box
  // forever. Generation-guarded and cleared on every terminal event.
  const STREAM_WATCHDOG_MS = 180_000;
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamWatchdogGenerationRef = useRef(0);

  const clearStreamWatchdog = useCallback(() => {
    streamWatchdogGenerationRef.current += 1;
    if (streamWatchdogRef.current) {
      clearTimeout(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
  }, []);

  const armStreamWatchdog = useCallback(() => {
    if (!streamActiveRef.current) return;
    if (streamWatchdogRef.current) clearTimeout(streamWatchdogRef.current);
    const generation = ++streamWatchdogGenerationRef.current;
    streamWatchdogRef.current = setTimeout(() => {
      streamWatchdogRef.current = null;
      if (streamWatchdogGenerationRef.current !== generation || !streamActiveRef.current) return;
      const runId = activeRunIdRef.current;
      flushPending();
      setUiLive(null);
      activeRunIdRef.current = null;
      streamActiveRef.current = false;
      // A watchdog with NO text is a genuine failure, not a quiet finish —
      // say so and let the user Retry (the box previously went blank 'done').
      if (!responseRef.current.trim()) {
        setError('The response stalled before any text arrived.');
        setErrorCode('timeout');
        setState('error');
      } else {
        if (runId) completeRun(runId, responseRef.current, uiSegmentsRef.current);
        setState((s) => (s === 'loading' || s === 'streaming' ? 'done' : s));
      }
      setStreamActive(false);
    }, STREAM_WATCHDOG_MS);
  }, [completeRun, flushPending]);

  useEffect(() => {
    const offChunk = ipc.onLLMChunk(({ runId, text, uiLive }) => {
      // Follow-along display that never submitted: adopt the streaming run
      // so the box follows the mouse. An overlay with its OWN live run
      // ignores foreign chunks (stale-run pollution guard).
      if (activeRunIdRef.current === null) {
        activeRunIdRef.current = runId;
        streamActiveRef.current = true;
        setStreamActive(true);
      }
      if (runId !== activeRunIdRef.current) return;
      // First chunk: spinner → streaming-pulse. Chunks are now BROADCAST to
      // every overlay (the answer box follows the mouse), so a follow-along
      // display that never called submit() arrives here from 'idle' — promote
      // it to 'streaming' so the box renders the live answer there too.
      setState((s) => (s === 'idle' || s === 'loading' ? 'streaming' : s));
      pendingChunkRef.current = { runId, text, uiLive: uiLive ?? null };
      armStreamWatchdog();
      if (!chunkTimerRef.current) {
        chunkTimerRef.current = setTimeout(flushPending, FLUSH_INTERVAL_MS);
      }
    });
    // The router's authoritative final answer REPLACES the streamed content —
    // streamed chunks can include tool-call junk that was cleaned out.
    const offFinal = ipc.onLLMFinal(({ runId, text, ui, annotations }) => {
      if (activeRunIdRef.current === null) {
        activeRunIdRef.current = runId;
      }
      if (runId !== activeRunIdRef.current) return;
      clearStreamWatchdog();
      streamActiveRef.current = false;
      flushPending();
      const segments = ui ?? [];
      responseRef.current = text;
      uiSegmentsRef.current = segments;
      setResponse(text);
      setUiSegments(segments);
      setUiLive(null);
      completeRun(runId, text, segments, annotations);
      setInterrupted(null);
      setError(null);
      setState('done');
      setStreamActive(false);
      lastAnswerAtRef.current = Date.now();
      if (queryStartRef.current !== null) {
        setElapsedSecs((Date.now() - queryStartRef.current) / 1000);
      }
    });
    const offDone = ipc.onLLMDone(({ runId }) => {
      if (runId !== activeRunIdRef.current) {
        if (swallowTrailingDoneRef.current && runId === supersededRunIdRef.current) {
          // Trailing `done` from the run this submit just cancelled — dropping
          // it keeps the fresh run coherent until the new stream chunks in.
          swallowTrailingDoneRef.current = false;
          supersededRunIdRef.current = null;
        }
        return;
      }
      clearStreamWatchdog();
      streamActiveRef.current = false;
      flushPending();
      setUiLive(null);
      completeRun(runId, responseRef.current, uiSegmentsRef.current);
      setState((s) => (s === 'streaming' || s === 'loading' ? 'done' : s));
      setStreamActive(false);
      if (queryStartRef.current !== null) {
        setElapsedSecs((Date.now() - queryStartRef.current) / 1000);
      }
    });
    const offError = ipc.onLLMError(({ runId, message, code }) => {
      if (runId !== activeRunIdRef.current) return;
      clearStreamWatchdog();
      streamActiveRef.current = false;
      activeRunIdRef.current = null;
      flushPending();
      setUiLive(null);
      setError(message);
      setErrorCode(typeof code === 'string' ? code : 'unknown');
      setInterrupted(null);
      setState('error');
      setStreamActive(false);
      if (queryStartRef.current !== null) {
        setElapsedSecs((Date.now() - queryStartRef.current) / 1000);
      }
    });
    // Failed after streaming text: keep the partial answer, never overwrite it
    // with an error state. Continue/Retry are rendered off `interrupted`.
    const offInterrupted = ipc.onLLMInterrupted(({ runId, message, code, text }) => {
      if (runId !== activeRunIdRef.current) return;
      clearStreamWatchdog();
      streamActiveRef.current = false;
      flushPending();
      setUiLive(null);
      const kept = (text ?? '').trim() ? text : responseRef.current;
      responseRef.current = kept;
      setResponse(kept);
      setInterrupted(message);
      setInterruptedCode(typeof code === 'string' ? code : 'unknown');
      setError(null);
      setState('done');
      setStreamActive(false);
      lastAnswerAtRef.current = Date.now();
      if (queryStartRef.current !== null) {
        setElapsedSecs((Date.now() - queryStartRef.current) / 1000);
      }
    });
    const offActivity = ipc.onToolActivity((a) => {
      armStreamWatchdog();
      if (a.kind === 'start') {
        setActivities((rows) => [
          ...rows,
          { id: a.id, name: a.name, label: a.label, status: 'running', args: a.args },
        ]);
      } else {
        setActivities((rows) =>
          rows.map((row) =>
            row.id === a.id
              ? { ...row, status: a.ok ? 'done' : 'error', summary: a.summary }
              : row,
          ),
        );
      }
    });
    const offReasoning = ipc.onLLMReasoning(({ delta }) => {
      armStreamWatchdog();
      pendingReasoningRef.current += delta;
      if (!chunkTimerRef.current) {
        chunkTimerRef.current = setTimeout(flushPending, FLUSH_INTERVAL_MS);
      }
    });
    return () => {
      clearStreamWatchdog();
      flushPending();
      offChunk();
      offFinal();
      offDone();
      offError();
      offInterrupted();
      offActivity();
      offReasoning();
    };
  }, [armStreamWatchdog, clearStreamWatchdog, completeRun, flushPending]);

  const submit = useCallback(async (prompt: string, options?: SubmitOptions) => {
    // Interrupting a live run must NOT wipe the ongoing answer — otherwise the
    // box collapses to the bare prompt overlay and the next answer just pops
    // in. Keep the current response/ui; the new run's chunks are latest-wins
    // FULL text, so they replace it seamlessly as they stream in, and the
    // cancelled run's trailing `llm:done` is swallowed so the fresh run stays
    // in its loading/streaming latch through the handoff.
    const interrupting = streamActiveRef.current;
    const previousRunId = activeRunIdRef.current;
    const runId = crypto.randomUUID();
    activeRunIdRef.current = runId;
    activePromptRef.current = prompt;
    activeWasWebRef.current = !!options?.web;
    completedRunIdRef.current = null;
    setCompletion(null);
    if (!interrupting) {
      setResponse('');
      setUiSegments([]);
    }
    setError(null);
    setErrorCode('unknown');
    setInterrupted(null);
    setActivities([]);
    setReasoning('');
    setElapsedSecs(null);
    queryStartRef.current = Date.now();
    pendingReasoningRef.current = '';
    swallowTrailingDoneRef.current = interrupting;
    supersededRunIdRef.current = interrupting ? previousRunId : null;
    setState('loading');
    setStreamActive(true);
    armStreamWatchdog();
    try {
      // Always use the options-flavored IPC so the chip state
      // (includeClipboard) reaches main even when
      // the user didn't touch the web/template knobs.
      await ipc.queryLLMWithOptions(prompt, {
        web: options?.web,
        templateId: options?.templateId,
        includeClipboard: options?.includeClipboard,
        fromChip: options?.fromChip,
        runId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send query');
      setState('error');
    }
  }, [armStreamWatchdog]);

  // Resume an interrupted answer. The partial was already committed to session
  // history by main, so a short instruction is enough — the model sees its own
  // truncated turn and continues from there.
  const continueLast = useCallback(
    () => submit('Continue exactly where you left off. Do not repeat what you already wrote.'),
    [submit],
  );

  // Re-run the original prompt from scratch (partial dropped from the UI; the
  // superseded run's late events are ignored by run id).
  const retryLast = useCallback(() => {
    const prompt = activePromptRef.current;
    if (!prompt) return Promise.resolve();
    return submit(prompt);
  }, [submit]);

  const reset = useCallback(() => {
    clearStreamWatchdog();
    flushPending();
    pendingChunkRef.current = null;
    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    activeRunIdRef.current = null;
    supersededRunIdRef.current = null;
    completedRunIdRef.current = null;
    setCompletion(null);
    setState('idle');
    setResponse('');
    setUiSegments([]);
    setUiLive(null);
    setError(null);
    setErrorCode('unknown');
    setInterrupted(null);
    setInterruptedCode('unknown');
    setActivities([]);
    setReasoning('');
    pendingReasoningRef.current = '';
    setStreamActive(false);
    lastAnswerAtRef.current = null;
  }, [clearStreamWatchdog, flushPending]);

  // Re-show a previous result (e.g. the box was hidden and re-triggered
  // within the session window — bring back the last answer so the user picks
  // up where they left off instead of a blank box). `segments` are the UI
  // blocks ([UI]/[QUESTIONS]/[MERMAID]) interleaved with the text; they are
  // stashed/restored alongside the text so re-opening the box shows the full
  // generated UI, not just the markdown.
  const restore = useCallback((text: string, segments?: UiSegment[]) => {
    setResponse(text);
    setUiSegments(segments ?? []);
  }, []);

  return { state, response, uiSegments, uiLive, error, errorCode, interrupted, interruptedCode, activities, reasoning, elapsedSecs, completion, consumeCompletion, submit, continueLast, retryLast, reset, restore, streamActive, streamActiveRef, lastAnswerAtRef };
}
