import { describe, expect, it } from 'vitest';
import {
  DOOM_STOP_AT,
  DOOM_WARN_AT,
  identicalStreak,
  isDoomLoop,
  safeToolFilename,
  SPILL_HEAD_CHARS,
  spillPointerText,
  toolCallSignature,
} from '../electron/llm/tool-spill';

describe('toolCallSignature', () => {
  it('is stable for equal args regardless of key order', () => {
    expect(toolCallSignature('click', { x: 1, y: 2 })).toBe(toolCallSignature('click', { x: 1, y: 2 }));
    expect(toolCallSignature('click', { x: 1 })).not.toBe(toolCallSignature('click', { x: 2 }));
    expect(toolCallSignature('click', {})).not.toBe(toolCallSignature('scroll', {}));
  });
});

describe('identicalStreak', () => {
  it('counts the trailing run including the upcoming call', () => {
    expect(identicalStreak([], 'a')).toBe(1);
    expect(identicalStreak(['a', 'a'], 'a')).toBe(3);
    expect(identicalStreak(['b', 'a', 'a'], 'a')).toBe(3);
    expect(identicalStreak(['a', 'b'], 'a')).toBe(1);
  });

  it('warns at 5, stops at 8', () => {
    expect(DOOM_WARN_AT).toBe(5);
    expect(DOOM_STOP_AT).toBe(8);
    const four = ['c', 'c', 'c', 'c'];
    expect(identicalStreak(four, 'c')).toBe(5);
    expect(isDoomLoop(four, 'c')).toBe(false);
    const seven = new Array(7).fill('c');
    expect(identicalStreak(seven, 'c')).toBe(8);
    expect(isDoomLoop(seven, 'c')).toBe(true);
  });
});

describe('spill helpers', () => {
  it('sanitizes filenames', () => {
    expect(safeToolFilename('run_command', 'a/b:c')).toBe('run_command-a_b_c.txt');
  });

  it('pointer text names the file and totals', () => {
    const t = spillPointerText('/w/.spirit/spills/x.txt', 9000);
    expect(t).toContain('/w/.spirit/spills/x.txt');
    expect(t).toContain('9000');
    expect(t).toContain(String(SPILL_HEAD_CHARS));
  });
});
