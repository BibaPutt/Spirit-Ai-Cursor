import { describe, expect, it } from 'vitest';
import { parseBingGrounding, parseDdgGrounding } from '../electron/llm/web-ground';

describe('parseDdgGrounding', () => {
  it('parses result__a + result__snippet pairs with entities decoded', () => {
    const html = `<div class="result">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.msi.com/laptops">MSI Laptops &amp; Gaming Laptops</a></h2>
<a class="result__snippet" href="https://www.msi.com/laptops">Find your gaming laptop with RTX GPUs.</a>
</div>
<div class="result">
<h2 class="result__title"><a class="result__a" href="https://en.wikipedia.org/wiki/MSI">MSI - Wikipedia</a></h2>
<a class="result__snippet" href="https://en.wikipedia.org/wiki/MSI">Micro-Star International is a Taiwanese electronics company.</a>
</div>`;
    const out = parseDdgGrounding(html, 'msi laptops');
    expect(out).toContain('[GROUNDED_SEARCH query="msi laptops"]');
    expect(out).toContain('MSI Laptops & Gaming Laptops');
    expect(out).toContain('https://www.msi.com/laptops');
    expect(out).toContain('Micro-Star International is a Taiwanese electronics company.');
  });

  it('returns empty on anomaly/challenge pages', () => {
    expect(parseDdgGrounding('<html>anomaly</html>', 'x')).toBe('');
  });
});

describe('parseBingGrounding', () => {
  it('parses b_algo blocks', () => {
    const html = `<li class="b_algo"><h2><a href="https://www.msi.com/laptops">MSI Laptops</a></h2><p>Gaming laptops with RTX GPUs.</p></li>
<li class="b_algo"><h2><a href="https://en.wikipedia.org/wiki/MSI">MSI - Wikipedia</a></h2><p>Micro-Star International, a Taiwanese company.</p></li>`;
    const out = parseBingGrounding(html, 'msi laptops');
    expect(out).toContain('MSI Laptops');
    expect(out).toContain('https://en.wikipedia.org/wiki/MSI');
    expect(out).toContain('Micro-Star International, a Taiwanese company.');
    expect(out).toContain('1. ');
  });

  it('returns empty on junk', () => {
    expect(parseBingGrounding('<html>challenge</html>', 'x')).toBe('');
  });
});
