import { describe, expect, it } from 'vitest';
import { frameHash } from '../electron/capture/frame-hash';

describe('frameHash', () => {
  it('is stable for the same frame string', () => {
    const s = 'aGVsbG8gd29ybGQ=';
    expect(frameHash(s)).toBe(frameHash(s));
  });

  it('changes when a single byte changes', () => {
    expect(frameHash('abc')).not.toBe(frameHash('abd'));
  });

  it('distinguishes strings that share a prefix but differ in length', () => {
    expect(frameHash('abc')).not.toBe(frameHash('abcabc'));
  });

  it('returns a compact key (hash + length)', () => {
    expect(frameHash('x')).toMatch(/^[0-9a-z]+:[0-9a-z]+$/);
  });
});
