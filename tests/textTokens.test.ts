import { describe, expect, it } from 'vitest';
import {
  lemmatizeForBm25,
  tokenizeSignificant,
  expandSynonyms,
  fuzzyTokenOverlap,
} from '../electron/llm/text-tokens';

describe('lemmatizeForBm25 / tokenizeSignificant', () => {
  it('strips stop words and stems', () => {
    expect(tokenizeSignificant('The users are planning vacations')).toEqual([
      'plann',
      'planning',
      'vacation',
    ]);
  });

  it('keeps -ing words alongside their stems', () => {
    const tokens = tokenizeSignificant('User is running');
    expect(tokens).toContain('runn');
    expect(tokens).toContain('running');
  });
});

describe('expandSynonyms', () => {
  it('maps a member to its whole family (stemmed)', () => {
    // precipitation stems to "precipite"; its family includes "rain".
    expect(expandSynonyms(['precipite'])).toContain('rain');
    expect(expandSynonyms(['vehicle'])).toContain('car');
  });

  it('leaves unknown tokens untouched', () => {
    expect(expandSynonyms(['platypus'])).toEqual(['platypus']);
  });
});

describe('fuzzyTokenOverlap', () => {
  it('matches near-identical tokens with the same first letter', () => {
    expect(fuzzyTokenOverlap(['definately'], ['definitely'])).toBe(1);
    expect(fuzzyTokenOverlap(['occurence'], ['occurrence'])).toBe(1);
  });

  it('rejects same-suffix-different-first-letter words', () => {
    // "train" and "brain" share 3/5 bigrams — must NOT match.
    expect(fuzzyTokenOverlap(['train'], ['brain'])).toBe(0);
  });

  it('counts multiple matches', () => {
    expect(
      fuzzyTokenOverlap(['definately', 'occurence'], ['definitely', 'occurrence']),
    ).toBe(2);
  });
});
