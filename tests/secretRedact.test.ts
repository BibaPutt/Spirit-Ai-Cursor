import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeMessagesPayload, sanitizeSecrets } from '../electron/llm/secret-redact';
import type { Message } from '../electron/llm/prompt';

describe('sanitizeSecrets', () => {
  it('redacts OpenAI-shaped API keys', () => {
    expect(sanitizeSecrets('my key is sk-abc1234567890123456789 ok')).toContain(REDACTED);
    expect(sanitizeSecrets('sk-abc1234567890123456789')).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('redacts Google AIza keys', () => {
    const s = sanitizeSecrets('key AIzaSy0123456789abcdefghijklmnopqrstuvwxyz end');
    expect(s).toContain(REDACTED);
    expect(s).not.toMatch(/AIza/);
  });

  it('redacts GitHub token shapes', () => {
    expect(sanitizeSecrets('token ghp_0123456789abcdefghijklmnopqrstuvwx')).not.toContain('ghp_');
    expect(sanitizeSecrets('token ghp_0123456789abcdefghijklmnopqrstuvwx')).toContain(REDACTED);
  });

  it('redacts bearer tokens', () => {
    const s = sanitizeSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
    expect(s).not.toMatch(/Bearer\s+\S+/);
    expect(s).toContain(REDACTED);
  });

  it('redacts url user:pass credentials but keeps the host', () => {
    const s = sanitizeSecrets('connect to https://alice:s3cret@example.com/db');
    expect(s).toBe('connect to https://***@example.com/db');
  });

  it('redacts password assignments', () => {
    expect(sanitizeSecrets('POST { password: "hunter2" }')).not.toMatch(/hunter2/);
    expect(sanitizeSecrets("x.password = 's3cret'")).not.toMatch(/s3cret/);
  });

  it('leaves ordinary prose and version numbers untouched', () => {
    const s = sanitizeSecrets('The B-tree index is 10x faster and costs 3.14. Also see nyc-example.com.');
    expect(s).toBe('The B-tree index is 10x faster and costs 3.14. Also see nyc-example.com.');
  });

  it('leaves session goal text untouched when redaction is over ashtray', () => {
    const s = sanitizeSecrets('open the settings and show me the download folder please');
    expect(s).toContain('open the settings');
  });
});

describe('sanitizeMessagesPayload', () => {
  it('returns the SAME array instance when nothing carries a secret', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'open the download folder please' },
      { role: 'assistant', content: 'understood' },
    ];
    const out = sanitizeMessagesPayload(msgs);
    expect(out).toBe(msgs);
  });

  it('keeps message shape and strips secrets from text content', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'here is my sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa key' },
      { role: 'assistant', content: 'understood' },
    ];
    const out = sanitizeMessagesPayload(msgs);
    expect(out[0].content).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(out[1].content).toBe('understood');
    // original untouched
    expect(msgs[0].content).toMatch(/sk-[A-Za-z0-9]/);
  });

  it('sanitizes image-part text without touching the image url', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'key ghp_0123456789abcdefghijklmnopqrstuvwx' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
        ],
      },
    ];
    const out = sanitizeMessagesPayload(msgs);
    const content = out[0].content;
    if (Array.isArray(content)) {
      expect(content[0]).toMatchObject({ type: 'text' });
      if (content[0].type === 'text') expect(content[0].text).not.toMatch(/ghp_/);
      expect(content[1]).toMatchObject({ type: 'image_url' });
    } else {
      throw new Error('expected array content');
    }
  });

  it('sanitizes assistant tool-call argument text', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'type_text', arguments: '{"text":"password = hunter22 "}' },
          },
        ],
      },
    ];
    const out = sanitizeMessagesPayload(msgs);
    if (out[0].role === 'assistant' && out[0].tool_calls) {
      expect(out[0].tool_calls[0].function.arguments).not.toMatch(/hunter22/);
    } else {
      throw new Error('expected assistant tool call');
    }
  });
});