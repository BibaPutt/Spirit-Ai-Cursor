import { describe, expect, it } from 'vitest';
import { CHAIN_LABELS, chainLabelFor, currentChainLabel } from '../renderer/lib/chainLabels';

describe('chainLabels', () => {
  it('1. maps core tool kinds to friendly labels', () => {
    expect(chainLabelFor('see_screen')).toBe('Looking at your screen');
    expect(chainLabelFor('click')).toBe('Clicking…');
    expect(chainLabelFor('thinking')).toBe('Thinking…');
  });

  it('2. enriches focus_window with the app name', () => {
    expect(chainLabelFor('focus_window', { app: 'Notepad' })).toBe('Focusing Notepad');
    expect(chainLabelFor('focus_window', {})).toBe(CHAIN_LABELS.focus_window);
  });

  it('3. keeps type_text short and supports a target app', () => {
    expect(chainLabelFor('type_text', { text: 'hello' })).toBe('Typing…');
    expect(chainLabelFor('type_text', { text: 'hi', app: 'Notepad' })).toBe('Typing into Notepad');
  });

  it('4. falls back to the main-process label or a prettified name', () => {
    expect(chainLabelFor('some_new_tool', undefined, 'Doing something')).toBe('Doing something');
    expect(chainLabelFor('some_new_tool')).toBe('Some New Tool');
  });

  it('5. prefers the running step for the header label', () => {
    const label = currentChainLabel([
      { name: 'see_screen', status: 'done', label: 'Looking at the screen' },
      { name: 'focus_window', args: { app: 'Notepad' }, status: 'running', label: 'Focusing Notepad' },
      { name: 'type_text', args: { text: 'hi' }, status: 'running', label: 'Typing 2 characters' },
    ]);
    // Last running entry wins (type_text here).
    expect(label).toBe('Typing…');
  });

  it('6. returns null with no activities', () => {
    expect(currentChainLabel([])).toBeNull();
  });
});
