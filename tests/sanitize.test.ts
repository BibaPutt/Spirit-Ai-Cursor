import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { sanitizeSchema } from '../renderer/components/sanitizeSchemas';

// Run the SAME rehype-sanitize pipeline the renderer uses against the
// baseline schema, and assert each attack payload is neutralized.
//
// IMPORTANT: this guards a security property (XSS hardening for LLM
// output). Any regression here is release-blocking — the CI workflow
// `test.yml` fails the build if `npm test` returns non-zero.

function sanitize(input: string): string {
  const out = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify)
    .processSync(input)
    .toString();
  return out;
}

describe('LLM output HTML sanitization', () => {
  it('1. strips <script> tags entirely', () => {
    const out = sanitize('<script>alert(1)</script>hello');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/alert\(1\)/);
    expect(out).toContain('hello');
  });

  it('2. keeps <img> but strips onerror handler', () => {
    const out = sanitize('<img src=x onerror=alert(1)>fallback');
    expect(out).toMatch(/<img /i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain('fallback');
  });

  it('3. keeps safe <a> links but neutralises javascript: hrefs', () => {
    const safe = sanitize('<a href="https://example.com">click</a>');
    expect(safe).toMatch(/<a /i);
    expect(safe).toContain('click');
    const evil = sanitize('<a href="javascript:alert(1)">click</a>');
    expect(evil).not.toMatch(/javascript:/i);
  });

  it('4. neutralises script-in-svg', () => {
    const out = sanitize('<svg><script>alert(1)</script><circle r="5"/></svg>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('<circle');
  });

  it('5. strips event handler attributes on svg', () => {
    const out = sanitize('<svg onload="alert(1)" viewBox="0 0 10 10"></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).toContain('viewBox');
  });

  it('6. drops attribute-injection attempts on class', () => {
    // The parser treats class="x' onclick='alert(1)" as a single class
    // attribute (the apostrophes get HTML-encoded inside the value). The
    // substring "onclick" appears INSIDE the encoded class value but is NOT
    // an active event handler — browsers do not re-parse attribute values as
    // attributes. We confirm safety by parsing the output as HTML and
    // checking the actual DOM attribute list, not by regexing the output.
    const out = sanitize(`<div class="x' onclick='alert(1)">y</div>`);
    const doc = new DOMParser().parseFromString(out, 'text/html');
    const div = doc.querySelector('div');
    expect(div).not.toBeNull();
    expect(div?.getAttribute('onclick')).toBeNull();
    expect(div?.hasAttribute('onclick')).toBe(false);
  });

  it('7. drops style attribute (no inline styles)', () => {
    const out = sanitize('<div style="background: url(javascript:alert(1))">x</div>');
    expect(out).not.toMatch(/style=/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  it('8. removes <iframe>', () => {
    const out = sanitize('<iframe src="https://attacker.example/"></iframe>');
    expect(out).not.toMatch(/<iframe/i);
  });

  it('9. removes <object>', () => {
    const out = sanitize('<object data="evil.swf"></object>');
    expect(out).not.toMatch(/<object/i);
  });

  it('10. removes <form> and clobbers inputs', () => {
    const out = sanitize('<form action="evil"><input name="x"></form>');
    expect(out).not.toMatch(/<form/i);
    expect(out).toContain('<input');
    expect(out).not.toMatch(/action="evil"/i);
  });

  it('11. keeps <details>/<summary> (legit rich answers)', () => {
    const out = sanitize('<details><summary>x</summary>y</details>');
    expect(out).toMatch(/<details/i);
    expect(out).toMatch(/<summary/i);
  });

  it('12. <meta> redirects are removed', () => {
    const out = sanitize('<meta http-equiv="refresh" content="0;url=evil.example">');
    expect(out).not.toMatch(/<meta/i);
  });

  it('13. nested malicious mix retains only safe text', () => {
    const out = sanitize(`
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
