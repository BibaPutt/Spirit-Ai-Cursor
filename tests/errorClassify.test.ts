import { describe, expect, it } from 'vitest';
import { classifyError, codeForStatus } from '../electron/llm/providers/error-classify';
import { ProviderHttpError } from '../electron/llm/providers/types';

describe('codeForStatus', () => {
  it('maps statuses to codes', () => {
    expect(codeForStatus(401)).toBe('auth');
    expect(codeForStatus(403)).toBe('auth');
    expect(codeForStatus(402)).toBe('credits');
    expect(codeForStatus(429)).toBe('overloaded');
    expect(codeForStatus(500)).toBe('overloaded');
    expect(codeForStatus(503)).toBe('overloaded');
    expect(codeForStatus(404)).toBe('unknown');
  });
});

describe('classifyError', () => {
  it('classifies ProviderHttpError by status', () => {
    const r = classifyError(new ProviderHttpError('rate limited', 429, 'openai'), 'OpenAI');
    expect(r.code).toBe('overloaded');
    expect(r.message).toMatch(/OpenAI/);
  });

  it('gives actionable auth/credits messages', () => {
    const auth = classifyError(new ProviderHttpError('invalid api key', 401, 'openai'), 'Gemini');
    expect(auth.code).toBe('auth');
    expect(auth.message).toMatch(/api key/i);

    const credits = classifyError(new ProviderHttpError('quota exceeded', 402, 'groq'), 'Groq');
    expect(credits.code).toBe('credits');
  });

  it('never blames an API key for keyless providers', () => {
    for (const id of ['opencode', 'localai'] as const) {
      const r = classifyError(new ProviderHttpError('rejected', 401, id), 'Opencode');
      expect(r.code).toBe('auth');
      expect(r.message).not.toMatch(/api key/i);
      expect(r.message).toMatch(/another model/i);
    }
  });

  it('classifies network-level failures', () => {
    expect(classifyError(new Error('fetch failed')).code).toBe('network');
    expect(classifyError(new Error('socket hang up')).code).toBe('network');
    expect(classifyError(new Error('ECONNREFUSED')).code).toBe('network');
  });

  it('classifies timeouts', () => {
    expect(classifyError(new Error('Request timed out after 150000ms')).code).toBe('timeout');
  });

  it('classifies thinking/token-budget overflow signatures', () => {
    const cases = [
      'This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.',
      'max_tokens limit of 2048 reached',
      'The model used its entire output budget on chain-of-thought and was cut off before answering.',
      'The model hit its output limit before producing any content.',
      'length exceeded for thinking',
      'Request was too long: you provided a prompt with too many tokens',
      'context window exceeded; exceeded the maximum output length',
      'A max token count has been reached for the reasoning model',
    ];
    for (const msg of cases) {
      expect(classifyError(new Error(msg)).code, msg).toBe('thinking-limit');
    }
  });

  it('does not misclassify ordinary overload/network errors as thinking-limit', () => {
    expect(classifyError(new Error('overloaded by demand')).code).toBe('unknown');
    expect(classifyError(new Error('fetch failed')).code).toBe('network');
  });

  it('classifies credit mentions in plain errors', () => {
    const r = classifyError(new Error('Insufficient credits for the request'));
    expect(r.code).toBe('credits');
    expect(r.message).toMatch(/credits|quota/i);
  });

  it('falls through to unknown with the raw message', () => {
    const r = classifyError(new Error('boom exploded weirdly'));
    expect(r.code).toBe('unknown');
    expect(r.message).toBe('boom exploded weirdly');
  });

  it('handles non-Error throws', () => {
    expect(classifyError('just a string').message).toBe('just a string');
    expect(classifyError(undefined).code).toBe('unknown');
  });
});