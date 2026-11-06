import { describe, expect, it } from 'vitest';
import { sanitizeDiagramHtml, DIAGRAM_CLASS_RE } from '../electron/llm/diagram-safe';

describe('sanitizeDiagramHtml — allowlist', () => {
  it('keeps allowed structural tags with dg-*/spirit-* classes', () => {
    const out = sanitizeDiagramHtml(
      '<div class="dg-flow"><div class="dg-box dg-accent">Build</div><span class="dg-label">OK</span></div>',
    );
    expect(out).toBe('<div class="dg-flow"><div class="dg-box dg-accent">Build</div><span class="dg-label">OK</span></div>');
  });

  it('keeps svg geometry tags and their presentation attrs', () => {
    const out = sanitizeDiagramHtml('<svg class="dg-accent"><rect x="1" y="2" width="10" height="5" fill="red" /></svg>');
    expect(out).toBe('<svg class="dg-accent"><rect x="1" y="2" width="10" height="5" fill="red" /></svg>');
  });

  it('strips a class that is not in the dg-*/spirit-* vocabulary', () => {
    const out = sanitizeDiagramHtml('<div class="flex z-50 mt-4">x</div>');
    expect(out).toBe('<div>x</div>');
  });

  it('drops attribute-less and empty-valued attributes', () => {
    const out = sanitizeDiagramHtml('<div class="dg-box" disabled data-x="" title="tip">x</div>');
    expect(out).toBe('<div class="dg-box" title="tip">x</div>');
  });

  it('escapes attribute values on output', () => {
    const out = sanitizeDiagramHtml('<div class="dg-box" title="a&quot;onmouseover=&quot;hax()">x</div>');
    expect(out).toBe('<div class="dg-box" title="a&amp;quot;onmouseover=&amp;quot;hax()">x</div>');
  });
});

describe('sanitizeDiagramHtml — blocklist', () => {
  it('drops script/style/iframe together with their content', () => {
    const out = sanitizeDiagramHtml(
      '<div class="dg-box">keep</div><script>evil()</script><style>body{}</style><iframe src="https://x"></iframe><div class="dg-box">also-kept</div>',
    );
    expect(out).toBe('<div class="dg-box">keep</div><div class="dg-box">also-kept</div>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('style');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('src=');
  });

  it('drops an img tag and everything trailing it (unclosed blocked tag consumes the tail)', () => {
    const out = sanitizeDiagramHtml('<div class="dg-box">a</div><img src="x" onerror="hax()"><div class="dg-box">b</div>');
    expect(out).toBe('<div class="dg-box">a</div>');
  });

  it('strips event handlers, inline styles, and anchor hrefs', () => {
    const out = sanitizeDiagramHtml(
      '<div class="dg-box" onclick="hax()" style="color:red">x</div><a href="https://evil.example">Link</a>',
    );
    expect(out).toBe('<div class="dg-box">x</div>Link');
  });

  it('drops attribute values that reference URLs', () => {
    const out = sanitizeDiagramHtml('<rect x="0" y="0" width="2" height="2" fill="url(#grad)" fill-opacity="0.5" />');
    expect(out).toBe('<rect x="0" y="0" width="2" height="2" fill-opacity="0.5" />');
    const js = sanitizeDiagramHtml('<div class="dg-box" title="javascript:alert(1)">x</div>');
    expect(js).toBe('<div class="dg-box">x</div>');
  });
});

describe('sanitizeDiagramHtml — unwrap / void / malformed', () => {
  it('unwraps unknown tags (children survive) and drops their closing tag', () => {
    const out = sanitizeDiagramHtml('<custom-tag class="dg-box">kept text</custom-tag>');
    expect(out).toBe('kept text');
  });

  it('renders void tags br/hr self-closed', () => {
    const out = sanitizeDiagramHtml('<div class="dg-box">a<br>b<hr>c</div>');
    expect(out).toBe('<div class="dg-box">a<br />b<hr />c</div>');
  });

  it('strips comments', () => {
    const out = sanitizeDiagramHtml('<!-- secret --><div class="dg-box">x</div>');
    expect(out).toBe('<div class="dg-box">x</div>');
    expect(out).not.toContain('secret');
  });

  it('tolerates malformed / unclosed markup without throwing', () => {
    expect(sanitizeDiagramHtml('<div class="dg-box">unclosed')).toBe('<div class="dg-box">unclosed');
    expect(sanitizeDiagramHtml('')).toBe('');
    expect(sanitizeDiagramHtml('   ')).toBe('');
  });
});

describe('DIAGRAM_CLASS_RE', () => {
  it('accepts single, multi, and spirit- prefixes; rejects everything else', () => {
    expect(DIAGRAM_CLASS_RE.test('dg-flow')).toBe(true);
    expect(DIAGRAM_CLASS_RE.test('dg-box dg-accent')).toBe(true);
    expect(DIAGRAM_CLASS_RE.test('spirit-accent-glow')).toBe(true);
    expect(DIAGRAM_CLASS_RE.test('flex')).toBe(false);
    expect(DIAGRAM_CLASS_RE.test('dg-box evil')).toBe(false);
  });
});