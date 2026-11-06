import { describe, expect, it } from 'vitest';
import { applySttPostFilter, parseWordOverrides } from '../electron/voice/sttPostFilter';

describe('parseWordOverrides', () => {
  it('parses arrow, fat-arrow and equals forms, skips junk', () => {
    expect(parseWordOverrides('spear it -> Spirit\npie tor ch => pytorch\nbad line\n a = b ')).toEqual([
      ['spear it', 'Spirit'],
      ['pie tor ch', 'pytorch'],
      ['a', 'b'],
    ]);
  });
});

describe('applySttPostFilter', () => {
  it('swaps spoken punctuation', () => {
    expect(applySttPostFilter('call me comma maybe question mark', '')).toBe('call me, maybe?');
    expect(applySttPostFilter('first line new line second line', '')).toBe('first line\nsecond line');
  });

  it('drops filler words without eating real words', () => {
    expect(applySttPostFilter('uh let me um think hmm about it', '')).toBe('let me think about it');
    expect(applySttPostFilter('I like pie', '')).toBe('I like pie');
  });

  it('applies personal overrides case-insensitively', () => {
    expect(applySttPostFilter('open spear it now', 'spear it -> Spirit')).toBe('open Spirit now');
  });

  it('handles Hindi spoken punctuation', () => {
    expect(applySttPostFilter('kaam khatm purn viram', '')).toBe('kaam khatm.');
  });
});
