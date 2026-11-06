import type { ProviderRoundResult } from './types';

// Shared SSE parser for OpenAI-compatible chat completions streams.
// Both OpenRouter and OpenAI direct emit this exact format.

type ToolCallAcc = {
  id: string;
  name: string;
  argsText: string;
};

export async function parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onReasoning?: (delta: string) => void,
  // Stall ceiling: abort when no bytes arrive for this long (0 = off).
  // A half-open server sends headers then goes silent — without this the
  // read loop hangs forever and the run looks frozen. Any received bytes
  // reset the clock, so slow-but-progressing streams are never cut.
  stallTimeoutMs = 0,
): Promise<ProviderRoundResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentText = '';
  let finishReason: string | null = null;
  const tools: ToolCallAcc[] = [];
  // Reasoning models stream chain-of-thought in `reasoning_content`. We
  // forward each delta live to the UI (the renderer's Chain of Thought panel)
  // AND keep a capped copy in the round result for final-answer diagnosis.
  let sawReasoning = false;
  let reasoningText = '';

  // When the caller aborts (ESC during a stream) we cancel the reader so the
  // underlying connection closes immediately. Without this the read loop
  // continues to drain bytes for hundreds of ms after fetch is aborted,
  // burning the user's provider quota.
  const onAbort = () => {
    try {
      // The reader's cancel() promise rejects with the abort reason when the
      // underlying fetch was aborted; swallow it so it can't surface as an
      // unhandledRejection in the main process.
      void reader.cancel('aborted by user').catch(() => {});
    } catch {
      /* reader may already be closed */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // Stall watchdog: no bytes for stallTimeoutMs means the server went
  // silent mid-stream. Throws a plain timeout error so retry/failover
  // engage instead of hanging the run.
  let stallTimer: NodeJS.Timeout | null = null;
  const armStall = (): void => {
    if (!stallTimeoutMs || stallTimeoutMs <= 0) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallTimer = null;
      onAbort();
      stallFired = true;
    }, stallTimeoutMs);
  };
  const clearStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  let stallFired = false;

  try {
    armStall();
    try {
      while (!signal?.aborted && !stallFired) {
        const { value, done } = await reader.read();
        if (done) break;
        armStall();
        buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = json?.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        const text: unknown = delta.content;
        if (typeof text === 'string' && text.length > 0) {
          // Local models occasionally emit raw control tokens (e.g.
          // "<|tool_call|>") as plain content instead of structured tool
          // calls; without stripping they leak into the final answer.
          const clean = text.replace(/<\|[^>]*>/g, '');
          if (clean.length > 0) {
            contentText += clean;
            onChunk(clean);
          }
        }

        const rt: unknown = delta.reasoning_content;
        if (typeof rt === 'string' && rt.length > 0) {
          sawReasoning = true;
          if (reasoningText.length < 4000) reasoningText += rt;
          onReasoning?.(rt);
        }

        const dtc: unknown = delta.tool_calls;
        if (Array.isArray(dtc)) {
          for (const tc of dtc) {
            const index = typeof tc.index === 'number' ? tc.index : 0;
            while (tools.length <= index) tools.push({ id: '', name: '', argsText: '' });
            const acc = tools[index];
            if (typeof tc.id === 'string' && tc.id) acc.id = tc.id;
            if (typeof tc.function?.name === 'string') acc.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') acc.argsText += tc.function.arguments;
          }
        }
      }
    }
    } catch (err) {
      // Stall timer cancels the reader, which rejects the pending read with
      // a cancel error — translate it back to a timeout so retry/failover
      // engage instead of surfacing a confusing cancel.
      if (stallFired) throw new Error('timeout: stream stalled — no data from the server');
      throw err;
    }
  } finally {
    clearStall();
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (stallFired) throw new Error('timeout: stream stalled — no data from the server');

  // If the caller aborted mid-stream (user ESC, or the per-round watchdog in
  // the router), the read loop above stopped with a truncated response. Throw
  // so the caller surfaces a clean "Canceled." error instead of treating the
  // partial output as a finished answer (which is what made tool runs look
  // like they silently self-canceled).
  if (signal?.aborted) throw new Error('Canceled');

  const toolCalls: ProviderRoundResult['toolCalls'] = [];
  for (const acc of tools) {
    if (!acc.name) continue;
    let args: Record<string, unknown> = {};
    // Malformed JSON args are NOT executed: keep the raw text so the router can
    // show the model exactly what it wrote and demand a fix (GenOffice-style
    // input-error recovery) instead of letting garbage args run.
    let inputError = false;
    if (acc.argsText.trim()) {
      try {
        args = JSON.parse(acc.argsText);
      } catch {
        inputError = true;
        args = { _raw: acc.argsText };
      }
    }
    toolCalls.push({
      id: acc.id || `call_${toolCalls.length}`,
      name: acc.name,
      args,
      inputError,
      // A 'length' finish (output cap) mid-call means the args are incomplete —
      // re-request, don't execute.
      truncated: finishReason === 'length',
    });
  }

  // Truncated with nothing to show: the model hit the output cap before
  // producing any content or tool call — almost always a reasoning model
  // that burned the whole budget thinking. Turn the silent empty round into
  // an actionable error instead of a mysteriously empty answer.
  if (finishReason === 'length' && !contentText && toolCalls.length === 0) {
    throw new Error(
      sawReasoning
        ? 'The model used its entire output budget on chain-of-thought and was cut off before answering. Raise the response token budget or disable the model\u2019s thinking mode.'
        : 'The model hit its output limit before producing any content.',
    );
  }

  return { contentText, toolCalls, finishReason, reasoningText };
}
