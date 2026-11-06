import { describe, expect, it } from 'vitest';
import {
  buildUserProfileLine,
  stripUserProfileLine,
  withUserProfileLine,
  type Message,
} from '../electron/llm/prompt';

describe('buildUserProfileLine', () => {
  it('is empty when nothing is known', () => {
    expect(buildUserProfileLine(null)).toBe('');
    expect(buildUserProfileLine({})).toBe('');
    expect(buildUserProfileLine({ name: '  ' })).toBe('');
  });

  it('names the user and role in one line', () => {
    expect(buildUserProfileLine({ name: 'Ana', role: 'designer' })).toBe(
      "About the user: the user's name is Ana; they work as designer.",
    );
  });

  it('ignores auto language', () => {
    expect(buildUserProfileLine({ preferredLanguage: 'auto' })).toBe('');
    expect(buildUserProfileLine({ preferredLanguage: 'German' })).toContain('German');
  });
});

describe('stripUserProfileLine / withUserProfileLine', () => {
  const sys = (content: string): Message[] => [{ role: 'system', content }];

  it('appends fresh and strips stale lines', () => {
    const first = withUserProfileLine(sys('base'), 'About the user: x.');
    expect(first[0].content).toContain('About the user: x.');
    const second = withUserProfileLine(first, 'About the user: y.');
    expect(second[0].content).toContain('y.');
    expect(second[0].content).not.toContain('x.');
  });

  it('empty line just strips', () => {
    const out = withUserProfileLine(sys('base\n\nAbout the user: old.'), '');
    expect(out[0].content).toBe('base');
  });

  it('leaves non-system messages alone', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }];
    expect(withUserProfileLine(msgs, 'About the user: x.')).toEqual(msgs);
  });
});
