import { describe, expect, it } from 'vitest';
import { splitWords, wordIndexAtChar, alignBoundaries } from '../renderer/lib/ttsWords';
import type { Boundary } from '../renderer/lib/ttsWords';

describe('splitWords', () => {
  it('splits on whitespace, keeping char offsets', () => {
    expect(splitWords('The  quick brown fox.')).toEqual([
      { text: 'The', start: 0 },
      { text: 'quick', start: 5 },
      { text: 'brown', start: 11 },
      { text: 'fox.', start: 17 },
    ]);
  });

  it('returns [] for empty/whitespace-only text', () => {
    expect(splitWords('')).toEqual([]);
    expect(splitWords('   \n  ')).toEqual([]);
  });
});

describe('wordIndexAtChar', () => {
  const words = splitWords('one two three');

  it('maps a word-start char to that word', () => {
    expect(wordIndexAtChar(words, 0)).toBe(0); // 'one'
    expect(wordIndexAtChar(words, 4)).toBe(1); // 'two'
    expect(wordIndexAtChar(words, 8)).toBe(2); // 'three'
  });

  it('maps mid-word chars to the containing word', () => {
    expect(wordIndexAtChar(words, 2)).toBe(0);
    expect(wordIndexAtChar(words, 6)).toBe(1);
  });

  it('clamps past-the-end chars to the last word', () => {
    expect(wordIndexAtChar(words, 99)).toBe(2);
  });

  it('returns -1 when there are no words', () => {
    expect(wordIndexAtChar([], 0)).toBe(-1);
  });
});

describe('alignBoundaries', () => {
  const words = splitWords('The quick brown fox');

  it('aligns matching words and converts ticks already handled upstream', () => {
    const boundaries: Boundary[] = [
      { text: 'The', offsetMs: 0, durationMs: 200 },
      { text: 'quick', offsetMs: 250, durationMs: 180 },
      { text: 'brown', offsetMs: 450, durationMs: 160 },
      { text: 'fox', offsetMs: 650, durationMs: 200 },
    ];
    expect(alignBoundaries(words, boundaries)).toEqual([
      { startMs: 0, endMs: 200 },
      { startMs: 250, endMs: 430 },
      { startMs: 450, endMs: 610 },
      { startMs: 650, endMs: 850 },
    ]);
  });

  it('tolerates trailing punctuation differences', () => {
    const boundaries: Boundary[] = [
      { text: 'The,', offsetMs: 0, durationMs: 200 },
      { text: 'quick', offsetMs: 250, durationMs: 180 },
      { text: 'brown!', offsetMs: 450, durationMs: 160 },
      { text: 'fox.', offsetMs: 650, durationMs: 200 },
    ];
    const out = alignBoundaries(words, boundaries);
    expect(out.every((t) => t !== null)).toBe(true);
    expect(out[0]?.startMs).toBe(0);
    expect(out[2]?.startMs).toBe(450);
  });

  it('fills gaps for tokens Edge did not report', () => {
    const boundaries: Boundary[] = [
      { text: 'The', offsetMs: 0, durationMs: 200 },
      { text: 'fox', offsetMs: 650, durationMs: 200 },
    ];
    const out = alignBoundaries(words, boundaries);
    expect(out[0]).toEqual({ startMs: 0, endMs: 200 });
    // 'quick' and 'brown' reuse the previous word's end time so the
    // highlight keeps moving instead of stalling.
    expect(out[1]?.startMs).toBe(200);
    expect(out[2]?.startMs).toBe(320);
    expect(out[3]).toEqual({ startMs: 650, endMs: 850 });
  });

  it('returns all null when there are no boundaries', () => {
    expect(alignBoundaries(words, [])).toEqual([null, null, null, null]);
  });
});
