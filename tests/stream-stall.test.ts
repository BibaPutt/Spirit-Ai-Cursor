import { describe, expect, it } from 'vitest';
import { parseOpenAIStream } from '../electron/llm/providers/openai-stream';

function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start() {
      // Never enqueues, never closes: the half-open server.
    },
  });
}

function sseStream(body: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(body);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

const CHUNK = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

describe('stream stall timeout', () => {
  it('a silent stream throws a timeout error', async () => {
    await expect(parseOpenAIStream(hangingStream(), () => {}, undefined, undefined, 40)).rejects.toThrow(
      /timeout: stream stalled/,
    );
  });

  it('a healthy stream is untouched by the stall timer', async () => {
    const res = await parseOpenAIStream(sseStream(CHUNK), () => {}, undefined, undefined, 1000);
    expect(res.contentText).toBe('hi');
  });

  it('off by default (0 = no timer)', async () => {
    const res = await parseOpenAIStream(sseStream(CHUNK), () => {});
    expect(res.contentText).toBe('hi');
  });
});
