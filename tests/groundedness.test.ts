import { describe, expect, it } from 'vitest';
import {
  assertGrounded,
  extractUrls,
  findUngroundedUrls,
  normalizeUrl,
} from '../electron/llm/groundedness';

const LABELED = [
  'CONTEXT AS OF 14:32:05',
  'Current app: Microsoft Edge (msedge)',
  'Active tab: MSI laptops - Google Search',
  'Active URL: https://www.msi.com/laptops?q=katana',
  'Selected text from screen: the Katana series starts at $1,299',
].join('\n');

describe('groundedness harness — URL claims', () => {
  it('extracts bare and markdown URLs from an answer', () => {
    expect(extractUrls('See https://example.com/a for details.')).toEqual(['https://example.com/a']);
    expect(extractUrls('Docs: [link](https://example.com/x). Also http://sub.example.org/y!')).toEqual([
      'https://example.com/x',
      'http://sub.example.org/y',
    ]);
    expect(extractUrls('no urls here')).toEqual([]);
  });

  it('normalizes scheme, www and trailing slashes for comparison', () => {
    expect(normalizeUrl('https://www.MSI.com/laptops/')).toBe('msi.com/laptops');
    expect(normalizeUrl('http://msi.com/laptops')).toBe('msi.com/laptops');
    expect(normalizeUrl('MSI.com')).toBe('msi.com');
  });

  it('accepts a URL that is present in the labeled context', () => {
    const answer = 'The Katana series is on the MSI laptops page: https://www.msi.com/laptops?q=katana';
    expect(findUngroundedUrls(answer, LABELED)).toEqual([]);
    expect(() => assertGrounded(answer, LABELED)).not.toThrow();
  });

  it('accepts an answer with no URL claims at all', () => {
    const answer = 'MSI makes gaming laptops.';
    expect(findUngroundedUrls(answer, LABELED)).toEqual([]);
  });

  it('flags a URL invented without support in the labeled context', () => {
    const answer = 'Check the real specs at https://en.wikipedia.org/wiki/MSI_Katana for pricing.';
    const violations = findUngroundedUrls(answer, LABELED);
    expect(violations).toEqual(['https://en.wikipedia.org/wiki/MSI_Katana']);
    expect(() => assertGrounded(answer, LABELED)).toThrow(/en\.wikipedia\.org\/wiki\/MSI_Katana/);
  });

  it('flags the exact invented domain even when the labeled context mentions a related one', () => {
    const answer = 'The latest is announced at https://msi-gaming.example/releases.';
    expect(findUngroundedUrls(answer, LABELED)).toEqual(['https://msi-gaming.example/releases']);
  });

  it('dedupes repeated mentions of the same ungrounded URL', () => {
    const answer = 'Go to https://msi-gaming.example now — https://msi-gaming.example is the hub.';
    expect(findUngroundedUrls(answer, LABELED)).toEqual(['https://msi-gaming.example']);
  });
});
