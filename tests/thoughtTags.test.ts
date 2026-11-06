import { describe, expect, it } from 'vitest';
import { splitThoughtTags, ThoughtTagExtractor } from '../electron/llm/thought-tags';

const answer = 'Opening Downloads for you.';
const reasoningText = 'the sidebar lists "Downloads"; that element is the target';

describe('splitThoughtTags', () => {
  it('drops a complete thought block from the answer and returns it as reasoning', () => {
    const s = splitThoughtTags(`[THOUGHT]${reasoningText}[/THOUGHT]${answer}`);
    expect(s.answer).toBe(answer);
    expect(s.reasoning).toBe(reasoningText);
  });

  it('handles THINKING / THINK variants case-insensitively', () => {
    expect(splitThoughtTags(`[THINKING]a[/THINKING]x`).answer).toBe('x');
    expect(splitThoughtTags(`[thinking]a[/thinking]x`).answer).toBe('x');
    expect(splitThoughtTags(`[THINK]a[/THINK]x`).reasoning).toBe('a');
    expect(splitThoughtTags(`[tHinK]a[/tHinK]x`).reasoning).toBe('a');
  });

  it('keeps preamble and trailing answer intact', () => {
    const s = splitThoughtTags(`Sure.[THOUGHT]hmm[/THOUGHT]Here.`);
    expect(s.answer).toBe('Sure.Here.');
    expect(s.reasoning).toBe('hmm');
  });

  it('concatenates multiple blocks', () => {
    const s = splitThoughtTags(`[THOUGHT]a[/THOUGHT]m[THOUGHT]b[/THOUGHT]n`);
    expect(s.answer).toBe('mn');
    // Reasoning concatenates verbatim (a separator would corrupt multi-line
    // thoughts); the extractor also exposes per-delta splits for streaming.
    expect(s.reasoning).toBe('ab');
  });

  it('treats an unclosed trailing thought as reasoning, not answer', () => {
    const s = splitThoughtTags(`${answer}[THOUGHT]still reasoning`);
    expect(s.answer).toBe(answer);
    expect(s.reasoning).toBe('still reasoning');
  });

  it('returns plain text verbatim when there are no tags', () => {
    const s = splitThoughtTags(answer);
    expect(s.answer).toBe(answer);
    expect(s.reasoning).toBe('');
  });
});

describe('ThoughtTagExtractor (streaming)', () => {
  it('resolves a tag split across deltas onto the correct channels', () => {
    const ex = new ThoughtTagExtractor();
    const first = ex.push('Opening');
    expect(first.answer).toBe('Opening');
    expect(first.reasoning).toBe('');
    const second = ex.push('[THOUGHT]the list says D');
    expect(second.answer).toBe('');
    expect(second.reasoning).toBe('the list says D');
    const third = ex.push('ownloads[/THOUGHT]');
    expect(third.answer).toBe('');
    expect(third.reasoning).toBe('ownloads');
    const fourth = ex.push(' for you.');
    expect(fourth.answer).toBe(' for you.');
    expect(fourth.reasoning).toBe('');
  });

  it('surfaces an unclosed trailing thought as reasoning (in push) and flush leaves the instance clean', () => {
    const ex = new ThoughtTagExtractor();
    const s = ex.push('[THOUGHT]never closed');
    expect(s.reasoning).toBe('never closed');
    expect(s.answer).toBe('');
    const tail = ex.flush();
    expect(tail.reasoning).toBe('');
    // Fully drained: a fresh run on the same instance is clean.
    const next = ex.push('hello');
    expect(next.answer).toBe('hello');
  });

  it('keeps free text flowing while thoughts are open between chunks', () => {
    const ex = new ThoughtTagExtractor();
    ex.push('a[THINKING]b');
    const mid = ex.push('c[/THINKING]d');
    expect(mid.answer).toBe('d');
    // b+c assembled as the reasoning across both deltas.
    expect(mid.reasoning).toBe('c');
  });

  it('tolerates spaced and attributed openers', () => {
    expect(splitThoughtTags('[ THOUGHT ]hmm[/THOUGHT ]ok').answer).toBe('ok');
    expect(splitThoughtTags('[THOUGHT x]hmm[/THOUGHT]ok').reasoning).toBe('hmm');
  });

  it('holds back a split opener instead of flashing it as answer', () => {
    const ex2 = new ThoughtTagExtractor();
    const first = ex2.push('Opening [THOU');
    expect(first.answer).toBe('Opening ');
    expect(first.reasoning).toBe('');
    const second = ex2.push('GHT]the list[/THOUGHT] done.');
    expect(second.answer).toBe('done.');
    expect(second.reasoning).toBe('the list');
  });

  it('releases a disproven partial opener as answer at flush', () => {
    const ex3 = new ThoughtTagExtractor();
    const first = ex3.push('array[');
    expect(first.answer).toBe('array');
    expect(ex3.flush().answer).toBe('[');
  });
});