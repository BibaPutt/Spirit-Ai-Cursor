import { describe, expect, it } from 'vitest';
import {
  IMAGE_TOKEN,
  MAX_IMAGE_QUERIES,
  parseImageRequestsFromAnswer,
} from '../electron/llm/web-images-parse';
import { isPublicImageUrl } from '../electron/llm/web-images';

describe('isPublicImageUrl', () => {
  it('1. accepts public https URLs', () => {
    expect(isPublicImageUrl('https://cdn.example.com/a.jpg')).toBe(true);
    expect(isPublicImageUrl('https://sub.domain.org:8443/a?x=1')).toBe(true);
  });

  it('2. rejects private / loopback / link-local IP literals', () => {
    expect(isPublicImageUrl('http://192.168.1.5/a.jpg')).toBe(false);
    expect(isPublicImageUrl('http://10.0.0.1/a.jpg')).toBe(false);
    expect(isPublicImageUrl('http://127.0.0.1/a.jpg')).toBe(false);
    expect(isPublicImageUrl('http://169.254.169.254/a.jpg')).toBe(false);
    expect(isPublicImageUrl('http://172.16.4.1/a.jpg')).toBe(false);
  });

  it('3. rejects local hostnames and non-http schemes', () => {
    expect(isPublicImageUrl('http://localhost/a.jpg')).toBe(false);
    expect(isPublicImageUrl('http://myhost.local/a.jpg')).toBe(false);
    expect(isPublicImageUrl('ftp://example.com/a.jpg')).toBe(false);
    expect(isPublicImageUrl('file:///c:/a.jpg')).toBe(false);
    expect(isPublicImageUrl('not a url')).toBe(false);
  });

  it('4. rejects RFC 2606 reserved placeholder hosts (model fabrication)', () => {
    expect(isPublicImageUrl('https://example.com/cow1')).toBe(false);
    expect(isPublicImageUrl('https://example.org/a.jpg')).toBe(false);
    expect(isPublicImageUrl('https://example.net/a.jpg')).toBe(false);
    expect(isPublicImageUrl('https://example.co/a.jpg')).toBe(false);
    expect(isPublicImageUrl('https://foo.example/a.jpg')).toBe(false);
    expect(isPublicImageUrl('https://anything.test/a.jpg')).toBe(false);
    expect(isPublicImageUrl('https://anything.invalid/a.jpg')).toBe(false);
  });
});

describe('parseImageRequestsFromAnswer', () => {
  it('1. parses [IMAGE] lines at the top and strips them from the text', () => {
    const answer = `${IMAGE_TOKEN} Eiffel Tower at night with lights\n\nHere is your answer about the tower.`;
    const { subjects, cleanText } = parseImageRequestsFromAnswer(answer);
    expect(subjects).toEqual(['Eiffel Tower at night with lights']);
    expect(cleanText).toBe('Here is your answer about the tower.');
  });

  it('2. unwraps a fence that wraps ONLY [IMAGE] lines', () => {
    const answer =
      '```\n' + `${IMAGE_TOKEN} a cow in a meadow\n` + '```\n\nAnswer text.';
    const { subjects, cleanText } = parseImageRequestsFromAnswer(answer);
    expect(subjects).toEqual(['a cow in a meadow']);
    expect(cleanText).toBe('Answer text.');
  });

  it('3. unwraps a fenced block with a language tag', () => {
    const answer =
      '```text\n' + `${IMAGE_TOKEN} a cow in a meadow\n` + '```\n\nAnswer text.';
    const { subjects, cleanText } = parseImageRequestsFromAnswer(answer);
    expect(subjects).toEqual(['a cow in a meadow']);
    expect(cleanText).toBe('Answer text.');
  });

  it('4. does NOT unwrap a code fence that contains other content', () => {
    const answer =
      '```\n' + `${IMAGE_TOKEN} a cow\n` + 'const x = 1;\n' + '```\n\nAnswer.';
    const { subjects, cleanText } = parseImageRequestsFromAnswer(answer);
    // The token line is still extracted wherever it appears…
    expect(subjects).toEqual(['a cow']);
    // …but the code fence itself is left intact.
    expect(cleanText).toContain('const x = 1;');
  });

  it('5. handles indented lines and trailing whitespace', () => {
    const answer = `  ${IMAGE_TOKEN}   a cow   \nAnswer.`;
    const { subjects, cleanText } = parseImageRequestsFromAnswer(answer);
    expect(subjects).toEqual(['a cow']);
    expect(cleanText).toBe('Answer.');
  });

  it('6. keeps up to 3 subjects and ignores the rest', () => {
    const lines = ['cow', 'pig', 'horse', 'duck'].map((s) => `${IMAGE_TOKEN} ${s}`);
    const answer = `${lines.join('\n')}\n\nAnswer.`;
    const { subjects, cleanText } = parseImageRequestsFromAnswer(answer);
    expect(subjects).toHaveLength(MAX_IMAGE_QUERIES);
    expect(subjects).toEqual(['cow', 'pig', 'horse']);
    expect(cleanText).toBe('Answer.');
  });

  it('7. NEVER matches prose — only a whole-line picture tag', () => {
    const prose = [
      'Here are the images: cow',
      'I can find images of a cow for you.',
      'The [IMAGE] cow is in the field.',
      'images of a cow are below',
      '[IMAGES] cow',
      '[image]',
      '[IMAGE]',
    ];
    for (const p of prose) {
      const { subjects, cleanText } = parseImageRequestsFromAnswer(p);
      expect(subjects, `prose must not match: "${p}"`).toEqual([]);
      expect(cleanText, `prose must stay untouched: "${p}"`).toBe(p);
    }
  });

  it('7b. accepts lowercase and bulleted tokens (weak models)', () => {
    const { subjects: lower } = parseImageRequestsFromAnswer('[image] a cow\nAnswer.');
    expect(lower).toEqual(['a cow']);
    const { subjects: bulleted } = parseImageRequestsFromAnswer('- [IMAGE] a cow\nAnswer.');
    expect(bulleted).toEqual(['a cow']);
  });

  it('8. no token → no subjects, text untouched', () => {
    const answer = 'Just a plain answer.';
    const { subjects, cleanText } = parseImageRequestsFromAnswer(answer);
    expect(subjects).toEqual([]);
    expect(cleanText).toBe('Just a plain answer.');
  });

  it('9. empty input is handled', () => {
    expect(parseImageRequestsFromAnswer('')).toEqual({
      subjects: [],
      cleanText: '',
    });
  });
});
