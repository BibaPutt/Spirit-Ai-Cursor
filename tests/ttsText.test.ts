import { describe, expect, it } from 'vitest';
import { latexToSpeech, stripMarkdownForTTS } from '../renderer/lib/ttsText';

describe('latexToSpeech', () => {
  it('reads inline math as speech, not dollar-sign source', () => {
    const out = latexToSpeech('$E = mc^2$');
    expect(out).not.toContain('$');
    expect(out).not.toContain('\\');
    expect(out).not.toContain('^');
    expect(out).toContain('equals');
    expect(out).toContain('c');
    expect(out).toContain('squared');
  });

  it('speaks fractions as "a over b"', () => {
    expect(latexToSpeech('\\frac{1}{2}')).toBe('1 over 2');
  });

  it('speaks square roots', () => {
    expect(latexToSpeech('\\sqrt{2}')).toBe('square root of 2');
  });

  it('speaks greek letters', () => {
    expect(latexToSpeech('\\pi \\approx 3.14')).toContain('pi');
    expect(latexToSpeech('\\pi \\approx 3.14')).toContain('approximately');
  });

  it('speaks bounded integrals as "integral from a to b"', () => {
    const out = latexToSpeech('\\int_{0}^{1}');
    expect(out).toContain('integral');
    expect(out).toContain('from 0 to 1');
  });

  it('speaks sums', () => {
    expect(latexToSpeech('\\sum_{i=1}')).toContain('sum from i equals 1');
  });

  it('strips math delimiters and layout characters', () => {
    const out = latexToSpeech('$$\\begin{aligned}a &= b + c \\end{aligned}$$');
    expect(out).not.toMatch(/[$\\{}]/);
    expect(out).toContain('a equals b + c');
  });

  it('reads percent as a word', () => {
    expect(latexToSpeech('50%')).toContain('percent');
  });
});

describe('stripMarkdownForTTS', () => {
  it('strips markdown formatting', () => {
    const out = stripMarkdownForTTS('# Hello\n\nSome **bold** and *italic* and `code` text');
    expect(out).toBe('Hello Some bold and italic and code text');
  });

  it('drops image/link markdown, keeps the label', () => {
    expect(stripMarkdownForTTS('[see here](https://x.com)')).toBe('see here');
    expect(stripMarkdownForTTS('![alt](img.png)')).toBe('');
  });

  it('strips list and blockquote markers', () => {
    const out = stripMarkdownForTTS('> note\n- first\n- second\n1. third');
    expect(out).toBe('note first second third');
  });

  it('combines markdown stripping with latex speech', () => {
    const out = stripMarkdownForTTS('So $E = mc^2$ and \\frac{1}{2}.');
    expect(out).not.toContain('$');
    expect(out).toContain('squared');
    expect(out).toContain('1 over 2');
  });
});
