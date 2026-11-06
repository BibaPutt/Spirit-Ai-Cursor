import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { OpenUiBlock } from '../renderer/components/OpenUiBlock';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lacks a few browser APIs the OpenUI components probe.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  (window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}
if (!('IntersectionObserver' in globalThis)) {
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const PROGRAM = [
  'root = Card([hdr, ttl, act])',
  'hdr = CardHeader("Q3 revenue")',
  'ttl = TextContent("Revenue grew 18%.", "small")',
  'act = Buttons([Button("Break this down", Action([@ToAssistant("Break it down by month")]))])',
].join('\n');

async function render(node: React.ReactElement): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('OpenUiBlock — real OpenUI renderer', () => {
  it('draws the model program with the official component library', async () => {
    const { host, unmount } = await render(<OpenUiBlock code={PROGRAM} />);
    expect(host.textContent).toContain('Q3 revenue');
    expect(host.textContent).toContain('Revenue grew 18%.');
    expect(host.textContent).toContain('Break this down');
    unmount();
  });

  it('submits a follow-up prompt when an @ToAssistant button is clicked', async () => {
    const onSubmit = vi.fn();
    const { host, unmount } = await render(<OpenUiBlock code={PROGRAM} onSubmit={onSubmit} />);
    const button = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Break this down'),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith('Break it down by month');
    unmount();
  });

  it('renders a partial program while streaming without throwing', async () => {
    const { host, unmount } = await render(<OpenUiBlock code={'root = Card([hdr])\nhdr = CardHeader("Rep'} streaming />);
    expect(host.querySelector('.spirit-openui')).toBeTruthy();
    unmount();
  });
});
