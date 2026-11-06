import { describe, expect, it } from 'vitest';
import { renderHtmlDocument, sanitizeHtml } from '../electron/save/template';

// Saved session docs are opened in the user's DEFAULT browser where the
// renderer's CSP does not apply, so LLM-emitted HTML must be scrubbed before
// it is embedded (template.ts sanitizeHtml). This guards the persisted-doc
// XSS surface. The live in-app path is separately covered by sanitize.test.ts
// (rehype-sanitize). Any regression here is a security issue.

describe('sanitizeHtml — saved-document HTML scrubbing', () => {
  it('1. strips <script> together with its content', () => {
    const out = sanitizeHtml('<script>alert(1)</script>hello');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/alert\(1\)/);
    expect(out).toContain('hello');
  });

  it('2. keeps <img> but strips the onerror handler', () => {
    const out = sanitizeHtml('<img src=x onerror=alert(1)>fallback');
    expect(out).toMatch(/<img /i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain('fallback');
  });

  it('3. keeps safe <a> links but neutralises javascript: hrefs', () => {
    const safe = sanitizeHtml('<a href="https://example.com">click</a>');
    expect(safe).toContain('href="https://example.com"');
    expect(safe).toContain('click');
    const evil = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(evil).not.toMatch(/javascript/i);
    expect(evil).toContain('click');
  });

  it('4. drops script-in-svg but keeps the svg shape', () => {
    const out = sanitizeHtml('<svg><script>alert(1)</script><circle r="5"/></svg>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('<circle');
  });

  it('5. strips event handlers on svg but keeps viewBox', () => {
    const out = sanitizeHtml('<svg onload="alert(1)" viewBox="0 0 10 10"></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).toContain('viewBox="0 0 10 10"');
  });

  it('6. drops inline style attributes entirely', () => {
    const out = sanitizeHtml('<div style="background: url(javascript:alert(1))">x</div>');
    expect(out).not.toMatch(/style=/i);
    expect(out).not.toMatch(/javascript/i);
    expect(out).toContain('x');
  });

  it('7. removes iframe / object / form-with-input completely', () => {
    const iframe = sanitizeHtml('<iframe src="https://attacker.example/"></iframe>');
    expect(iframe).not.toMatch(/<iframe/i);
    const obj = sanitizeHtml('<object data="evil.swf"></object>');
    expect(obj).not.toMatch(/<object/i);
    const form = sanitizeHtml('<form action="evil"><input name="x"></form>');
    expect(form).not.toMatch(/<form/i);
    expect(form).not.toMatch(/<input/i);
    expect(form).not.toMatch(/evil/i);
  });

  it('8. neutralises entity-encoded javascript: hrefs (&#106;avascript:)', () => {
    const out = sanitizeHtml('<a href="&#106;avascript:alert(1)">click</a>');
    expect(out).not.toMatch(/javascript/i);
    expect(out).toContain('click');
    expect(out).not.toMatch(/href=/);
  });

  it('9. neutralises whitespace-smuggled scheme (java\\tscript:)', () => {
    const out = sanitizeHtml('<a href="java\tscript:alert(1)">click</a>');
    expect(out).not.toMatch(/javascript/i);
    expect(out).not.toMatch(/href=/);
  });

  it('10. removes <meta> redirects', () => {
    const out = sanitizeHtml('<meta http-equiv="refresh" content="0;url=evil.example">');
    expect(out).not.toMatch(/<meta/i);
  });

  it('11. keeps legitimate rich structure (details, table, card div)', () => {
    const out = sanitizeHtml(
      '<details><summary>x</summary>y</details><div class="card"><table><tr><td>a</td></tr></table></div>',
    );
    expect(out).toContain('<details><summary>x</summary>y</details>');
    expect(out).toContain('<div class="card">');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>a</td>');
  });

  it('12. fail-closed: an unterminated <script> drops the rest of the input', () => {
    const out = sanitizeHtml('safe text <script>alert(1)');
    expect(out).toContain('safe text');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/alert\(1\)/);
  });

  it('13. nested malicious mix retains only safe content', () => {
    const out = sanitizeHtml(`
      <div class="safe-fact">Safe fact</div>
      <script>steal()</script>
      <a href="javascript:alert(1)">click</a>
      <svg onload="alert(1)"><script>x</script></svg>
      <p>final ok</p>
    `);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).toContain('Safe fact');
    expect(out).toContain('final ok');
  });
});

describe('renderHtmlDocument — saved-doc template is sanitised end to end', () => {
  const opts = { web: false, generatedAt: new Date('2026-01-01T00:00:00Z') };

  it('scrubs script tags out of markdown before embedding', async () => {
    const html = await renderHtmlDocument({
      ...opts,
      prompt: 'test',
      markdown: '# Hi\n\n<script>alert(1)</script>hello',
    });
    // LLM-emitted <script> must be stripped from the body
    const body = html.match(/<article class="ai-doc__body">([\s\S]*?)<\/article>/)?.[1] ?? '';
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/alert\(1\)/);
    expect(html).toContain('hello');
  });

  it('escapes the prompt in the title even when it contains HTML', async () => {
    const html = await renderHtmlDocument({
      ...opts,
      prompt: '<img src=x onerror=alert(1)>',
      markdown: 'hello',
    });
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/onerror=/);
    expect(html).toContain('&lt;img');
  });

  it('scrubs raw-HTML responses (looksLikeHtml path) before embedding', async () => {
    const html = await renderHtmlDocument({
      ...opts,
      prompt: 'test',
      markdown: '<html><body><script>steal()</script><div class="card">ok</div></body></html>',
    });
    // LLM-emitted <script> must be stripped from the body
    const body = html.match(/<article class="ai-doc__body">([\s\S]*?)<\/article>/)?.[1] ?? '';
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/steal\(\)/);
    expect(html).toContain('ok');
  });
});
