import { describe, expect, it } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { AnimatePresence } from 'framer-motion';
import { ChainPanel } from '../renderer/components/ChainPanel';
import { ToolApproval } from '../renderer/components/ToolApproval';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function render(el: React.ReactElement): () => void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(el);
  });
  return () => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
}

const req = { id: 'a1', label: 'Focusing Notepad', args: { app: 'Notepad', window: 'Notepad' } };

describe('approval-moment render (react #310 hunt)', () => {
  it('ToolApproval renders focus_window args', () => {
    const off = render(<ToolApproval request={req} onDecide={() => {}} />);
    expect(document.body.textContent).toContain('Focusing Notepad');
    off();
  });

  it('ChainPanel renders the running focus_window row', () => {
    const off = render(
      <ChainPanel
        activities={[
          { id: 't1', name: 'focus_window', label: 'Focusing Notepad', status: 'running', args: { app: 'Notepad', window: 'Notepad' } },
        ]}
        reasoning=""
        busy
        hasResponse={false}
      />,
    );
    expect(document.body.textContent).toContain('Focusing');
    off();
  });

  it('ToolApproval mounts inside AnimatePresence like PromptInput does', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const list = (rs: typeof req[]) =>
      rs.map((r) => <ToolApproval key={r.id} request={r} onDecide={() => {}} />);
    act(() => {
      root.render(<AnimatePresence initial={false}>{list([])}</AnimatePresence>);
    });
    act(() => {
      root.render(<AnimatePresence initial={false}>{list([req])}</AnimatePresence>);
    });
    expect(document.body.textContent).toContain('Focusing Notepad');
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it('ChainPanel survives empty -> thinking -> running -> empty (hooks order)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const row = {
      id: 't1', name: 'focus_window', label: 'Focusing Notepad',
      status: 'running' as const, args: { app: 'Notepad', window: 'Notepad' },
    };
    const show = (props: { busy: boolean; rows: typeof row[]; reasoning: string }) =>
      act(() => {
        root.render(
          <ChainPanel activities={props.rows} reasoning={props.reasoning} busy={props.busy} hasResponse={false} />,
        );
      });
    // The exact approval-moment sequence: idle -> pure thinking -> first
    // tool row -> back to idle. Hooks after an early return threw React
    // #310 here and bricked the whole box.
    show({ busy: false, rows: [], reasoning: '' });
    show({ busy: true, rows: [], reasoning: '' });
    show({ busy: true, rows: [row], reasoning: '' });
    show({ busy: true, rows: [{ ...row, status: 'done' as const }], reasoning: '' });
    show({ busy: false, rows: [], reasoning: '' });
    expect(document.body.textContent ?? '').not.toContain('undefined');
    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
