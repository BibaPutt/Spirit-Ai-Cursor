import { describe, expect, it } from 'vitest';
import { latexToUnicodeText } from '../electron/llm/latex-text';

describe('latexToUnicodeText', () => {
  it('leaves plain prose untouched', () => {
    expect(latexToUnicodeText('The Save button is at the top')).toBe(
      'The Save button is at the top',
    );
  });

  it('maps Greek letters', () => {
    expect(latexToUnicodeText('\\alpha \\beta \\Delta \\Omega')).toBe('α β Δ Ω');
  });

  it('maps operators', () => {
    expect(latexToUnicodeText('a \\neq b \\leq c \\times d \\rightarrow e')).toBe(
      'a ≠ b ≤ c × d → e',
    );
  });

  it('renders fractions (single digits → vulgar, otherwise a/b)', () => {
    expect(latexToUnicodeText('\\frac{1}{2} x')).toBe('½ x');
    expect(latexToUnicodeText('\\frac{a}{b}')).toBe('a/b');
    expect(latexToUnicodeText('\\frac{3}{4}')).toBe('¾');
  });

  it('renders square roots (with optional degree)', () => {
    expect(latexToUnicodeText('\\sqrt{x}')).toBe('√x');
    expect(latexToUnicodeText('\\sqrt[3]{8}')).toBe('³√8');
  });

  it('renders sub/superscripts to Unicode when a glyph exists', () => {
    expect(latexToUnicodeText('x_1')).toBe('x₁');
    expect(latexToUnicodeText('x^2')).toBe('x²');
    expect(latexToUnicodeText('E = mc^2')).toBe('E = mc²');
    expect(latexToUnicodeText('e^{-x}')).toBe('e⁻ˣ');
    expect(latexToUnicodeText('\\beta_1')).toBe('β₁');
  });

  it('falls back to wrapped notation for unsupported multi-char groups', () => {
    expect(latexToUnicodeText('x_{xy}')).toBe('x_(xy)');
    expect(latexToUnicodeText('x^{q}')).toBe('x^(q)');
  });

  it('turns \\text{...} and nested groups into plain text', () => {
    expect(latexToUnicodeText('\\text{C=O}')).toBe('C=O');
    expect(latexToUnicodeText('\\mathrm{H}_2O')).toBe('H₂O');
    expect(latexToUnicodeText('\\frac{\\text{HT}}{\\text{LB}}')).toBe('HT/LB');
  });

  it('drops \\left/\\right delimiters to plain parens', () => {
    expect(latexToUnicodeText('\\left( \\frac{1}{2} \\right)')).toBe('(½)');
  });

  it('adds combining marks for \\bar / \\vec / \\hat', () => {
    expect(latexToUnicodeText('\\bar{x}')).toBe('x̄');
    expect(latexToUnicodeText('\\vec{v}')).toBe('v⃗');
    expect(latexToUnicodeText('\\hat{a}')).toBe('â');
  });

  it('handles a realistic chemistry label', () => {
    expect(latexToUnicodeText('\\text{C=O} \\times \\frac{1}{2} bond')).toBe('C=O × ½ bond');
  });

  it('survives unknown commands by dropping the backslash', () => {
    expect(latexToUnicodeText('\\somecommands{x}')).toBe('somecommands{x}');
  });
});