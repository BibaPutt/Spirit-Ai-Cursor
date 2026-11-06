import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { TurnScrubber, type TurnChapter } from '../renderer/components/TurnScrubber';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const CHAPTERS: TurnChapter[] = [
  { id: 't1', title: 'First question', description: 'First answer snippet', meta: 'Q1' },
  { id: 't2', title: 'Second question', description: 'Second answer snippet', meta: 'Q2' },
  { id: 't3', title: 'Third question', description: 'Third answer snippet', meta: 'Q3' },
];

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

describe('TurnScrubber', () => {
  it('renders nothing without chapters', () => {
    const off = render(<TurnScrubber chapters={[]} />);
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    off();
  });

  it('renders one tick per chapter with the question as its label', () => {
    const off = render(<TurnScrubber chapters={CHAPTERS} />);
    const box = document.body.querySelector('[role="listbox"]');
    expect(box?.querySelectorAll('[role="option"]').length).toBe(3);
    expect(document.body.textContent ?? '').toContain('First question');
    off();
  });

  it('click selects the right chapter', () => {
    const onSelect = vi.fn();
    const off = render(<TurnScrubber chapters={CHAPTERS} onSelect={onSelect} />);
    const opts = document.body.querySelectorAll('[role="option"]');
    act(() => {
      (opts[1] as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: 't2' });
    expect(onSelect.mock.calls[0][1]).toBe(1);
    off();
  });

  it('keyboard walks the rail and Enter selects', () => {
    const onSelect = vi.fn();
    const off = render(<TurnScrubber chapters={CHAPTERS} onSelect={onSelect} />);
    const opts = document.body.querySelectorAll('[role="option"]');
    act(() => {
      (opts[0] as HTMLElement).focus();
    });
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('aria-label') ?? '').toContain('Second question');
    off();
  });
});
