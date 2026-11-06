import { describe, expect, it } from 'vitest';
import { splitLatex } from '../renderer/components/LatexInline';

describe('splitLatex', () => {
  it('passes through plain text as a single segment', () => {
    expect(splitLatex('just words')).toEqual([
      { math: false, body: 'just words', display: false },
    ]);
  });

  it('splits inline $...$ math', () => {
    const segs = splitLatex('E = $mc^2$ energy');
    expect(segs.filter((s) => s.math)).toEqual([
      { math: true, body: 'mc^2', display: false },
    ]);
    expect(segs.filter((s) => !s.math).map((s) => s.body)).toEqual(['E = ', ' energy']);
  });

  it('marks $$...$$ as display math', () => {
    const segs = splitLatex('block $$x + y$$ end');
    expect(segs.find((s) => s.math)?.display).toBe(true);
  });

  it('normalizes \\( \\) and \\[ \\] forms', () => {
    const inline = splitLatex('Einstein \\(E = mc^2\\) wrote');
    expect(inline.find((s) => s.math)).toMatchObject({ body: 'E = mc^2', display: false });

    const display = splitLatex('sum \\[\\sum_k k\\]');
    expect(display.find((s) => s.math)?.display).toBe(true);
  });

  it('treats escaped \\$ as a literal dollar, not math', () => {
    const segs = splitLatex('costs \\$5 and $10');
    expect(segs).toHaveLength(1);
    expect(segs[0].body).toBe('costs $5 and $10');
  });

  it('does not treat a $ followed by whitespace as math', () => {
    const segs = splitLatex('price $ 10');
    expect(segs[0]).toMatchObject({ math: false, body: 'price $ 10' });
  });

  it('keeps an unclosed $ as literal text', () => {
    const segs = splitLatex('about $10 to go');
    expect(segs[0]).toMatchObject({ math: false, body: 'about $10 to go' });
  });

  it('handles empty and null-ish input', () => {
    expect(splitLatex('')).toEqual([{ math: false, body: '', display: false }]);
    expect(splitLatex('   ')).toEqual([{ math: false, body: '   ', display: false }]);
  });

  it('trims whitespace inside math bodies', () => {
    const segs = splitLatex('$  x  $');
    expect(segs.find((s) => s.math)?.body).toBe('x');
  });

  it('multiple math segments in one string', () => {
    const maths = splitLatex('$a$ and $b$ and $$c$$').filter((s) => s.math);
    expect(maths.map((s) => [s.body, s.display])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
  });
});