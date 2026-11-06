import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { useLLMQuery } from '../renderer/hooks/useLLMQuery';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Cb = (p: never) => void;

const listeners: Record<string, Cb[]> = {};
let lastQueryOptions: unknown = null;
let lastPrompt = '';

function mockSpirit() {
  for (const k of Object.keys(listeners)) delete listeners[k];
  lastQueryOptions = null;
  lastPrompt = '';
  const api: Record<string, unknown> = {
    queryLLMWithOptions: vi.fn(async (prompt: string, opts: unknown) => {
      lastPrompt = prompt;
      lastQueryOptions = opts;
    }),
  };
  for (const name of [
    'onLLMChunk', 'onLLMFinal', 'onLLMDone', 'onLLMError', 'onLLMInterrupted',
    'onLLMReasoning', 'onToolActivity',
  ]) {
    api[name] = (cb: Cb) => {
      (listeners[name] ??= []).push(cb);
      return () => {};
    };
  }
  (window as unknown as Record<string, unknown>).spirit = api;
}

function emit(name: string, payload: unknown): void {
  act(() => {
    for (const cb of listeners[name] ?? []) (cb as (p: unknown) => void)(payload);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 70));
  });
}

function renderHook(): { hook: () => ReturnType<typeof useLLMQuery>; off: () => void } {
  let current!: ReturnType<typeof useLLMQuery>;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  function Probe() {
    current = useLLMQuery();
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return {
    hook: () => current,
    off: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe('interrupted runs keep the partial answer', () => {
  beforeEach(() => {
    mockSpirit();
  });

  it('keeps streamed text, flags interrupted, and clears the error', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('explain the build');
    });
    const runId = (lastQueryOptions as { runId: string }).runId;

    emit('onLLMChunk', { runId, text: 'Step one is', uiLive: null });
    await settle();
    emit('onLLMChunk', { runId, text: 'Step one is: install.', uiLive: null });
    await settle();

    emit('onLLMInterrupted', {
      runId,
      message: 'All providers failed. Last error: timed out',
      code: 'timeout',
      text: 'Step one is: install.',
    });
    await settle();

    const hook = h.hook();
    expect(hook.response).toBe('Step one is: install.');
    expect(hook.state).toBe('done');
    expect(hook.error).toBeNull();
    expect(hook.interrupted).toMatch(/timed out/);
    expect(hook.interruptedCode).toBe('timeout');
    expect(hook.streamActive).toBe(false);
    h.off();
  });

  it('ignores an interrupted event from a superseded run', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('first');
    });
    const first = (lastQueryOptions as { runId: string }).runId;
    await act(async () => {
      await h.hook().submit('second');
    });
    emit('onLLMInterrupted', { runId: first, message: 'old', code: 'timeout', text: 'POISON' });
    await settle();
    expect(h.hook().response).not.toContain('POISON');
    expect(h.hook().interrupted).toBeNull();
    h.off();
  });

  it('Continue resubmits a resume instruction and clears the interrupted flag', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('explain the build');
    });
    const runId = (lastQueryOptions as { runId: string }).runId;
    emit('onLLMInterrupted', { runId, message: 'timeout', code: 'timeout', text: 'Step one' });
    await settle();
    expect(h.hook().interrupted).toBe('timeout');

    await act(async () => {
      await h.hook().continueLast();
    });
    expect(lastPrompt).toMatch(/^Continue exactly where you left off/);
    expect(h.hook().interrupted).toBeNull();
    h.off();
  });

  it('Retry resubmits the original prompt', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('explain the build');
    });
    const runId = (lastQueryOptions as { runId: string }).runId;
    emit('onLLMInterrupted', { runId, message: 'timeout', code: 'timeout', text: 'Step one' });
    await settle();

    await act(async () => {
      await h.hook().retryLast();
    });
    expect(lastPrompt).toBe('explain the build');
    expect(h.hook().interrupted).toBeNull();
    h.off();
  });

  it('a hard error still clears interrupted and shows the error', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('hello');
    });
    const runId = (lastQueryOptions as { runId: string }).runId;
    emit('onLLMInterrupted', { runId, message: 'timeout', code: 'timeout', text: 'partial' });
    await settle();
    emit('onLLMError', { runId: `${runId}-next`, message: 'boom', code: 'network' });
    emit('onLLMError', { runId, message: 'boom', code: 'network' });
    await settle();
    expect(h.hook().interrupted).toBeNull();
    expect(h.hook().error).toBe('boom');
    h.off();
  });
});
