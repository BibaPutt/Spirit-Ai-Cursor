import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { useLLMQuery } from '../renderer/hooks/useLLMQuery';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Cb = (p: never) => void;

const listeners: Record<string, Cb[]> = {};
let lastQueryOptions: unknown = null;

function mockSpirit() {
  for (const k of Object.keys(listeners)) delete listeners[k];
  lastQueryOptions = null;
  const api: Record<string, unknown> = {
    queryLLMWithOptions: vi.fn(async (_prompt: string, opts: unknown) => {
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

describe('run lifecycle (runId filtering + completion)', () => {
  beforeEach(() => {
    mockSpirit();
  });

  it('submit passes a runId to main', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('hello');
    });
    expect(lastQueryOptions).toMatchObject({ runId: expect.any(String) });
    h.off();
  });

  it('foreign-run chunks are dropped, own final commits a completion', async () => {
    const h = renderHook();
    let runId = '';
    await act(async () => {
      await h.hook().submit('hello');
    });
    runId = (lastQueryOptions as { runId: string }).runId;
    emit('onLLMChunk', { runId: 'other-run', text: 'POISON', uiLive: null });
    await settle();
    expect(h.hook().response).not.toContain('POISON');
    emit('onLLMFinal', { runId, text: 'real answer', ui: [] });
    await settle();
    expect(h.hook().response).toBe('real answer');
    expect(h.hook().completion).toMatchObject({ runId, prompt: 'hello', response: 'real answer' });
    h.off();
  });

  it('stale trailing done does not flip the fresh run', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('first');
    });
    const first = (lastQueryOptions as { runId: string }).runId;
    await act(async () => {
      await h.hook().submit('second');
    });
    const second = (lastQueryOptions as { runId: string }).runId;
    expect(second).not.toBe(first);
    emit('onLLMDone', { runId: first });
    await settle();
    expect(h.hook().state).toBe('loading');
    emit('onLLMDone', { runId: second });
    await settle();
    expect(h.hook().state).toBe('done');
    h.off();
  });

  it('consuming a completion clears it so the newest turn gets a tick', async () => {
    const h = renderHook();
    await act(async () => {
      await h.hook().submit('hello');
    });
    const runId = (lastQueryOptions as { runId: string }).runId;
    emit('onLLMFinal', { runId, text: 'done answer', ui: [] });
    await settle();
    expect(h.hook().completion).toMatchObject({ runId });
    act(() => {
      h.hook().consumeCompletion();
    });
    expect(h.hook().completion).toBeNull();
    h.off();
  });
});
