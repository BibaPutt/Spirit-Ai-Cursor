import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const setMetadataSpy = vi.fn();
const toStreamSpy = vi.fn();
const closeSpy = vi.fn();

vi.mock('msedge-tts', () => ({
  OUTPUT_FORMAT: { AUDIO_24KHZ_96KBITRATE_MONO_MP3: 'audio-24khz-96kbitrate-mono-mp3' },
  MsEdgeTTS: class {
    setMetadata = setMetadataSpy;
    toStream = toStreamSpy;
    close = closeSpy;
  },
}));

import { synthesizeSpeech, parseWordBoundariesChunk } from '../electron/voice/tts';

function streamOf(...chunks: Buffer[]): Readable {
  return Readable.from(chunks);
}

describe('synthesizeSpeech (Edge TTS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects on empty or whitespace-only text', async () => {
    await expect(synthesizeSpeech('')).rejects.toThrow('Nothing to read aloud.');
    await expect(synthesizeSpeech('   ')).rejects.toThrow('Nothing to read aloud.');
    expect(setMetadataSpy).not.toHaveBeenCalled();
  });

  it('synthesizes with en-US-AriaNeural, returns base64 MP3 and closes', async () => {
    const first = Buffer.from([0x49, 0x44, 0x33]); // 'ID3'
    const second = Buffer.from([0x01, 0x02, 0x03]);
    toStreamSpy.mockReturnValue({ audioStream: streamOf(first, second), metadataStream: null });

    const result = await synthesizeSpeech('  hello world  ');

    expect(setMetadataSpy).toHaveBeenCalledWith(
      'en-US-AriaNeural',
      'audio-24khz-96kbitrate-mono-mp3',
      { wordBoundaryEnabled: true },
    );
    expect(toStreamSpy).toHaveBeenCalledWith('hello world');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(Buffer.from(result.audioBase64, 'base64')).toEqual(Buffer.concat([first, second]));
    expect(closeSpy).toHaveBeenCalled();
  });

  it('collects word boundaries from the metadata stream', async () => {
    const meta = JSON.stringify({
      Metadata: [
        { type: 'SentenceBoundary', offset: 0, duration: 10000000, text: { text: 'Hi there', length: 8 } },
        { type: 'WordBoundary', offset: 1000000, duration: 2000000, text: { text: 'Hello', length: 5 } },
        { type: 'WordBoundary', offset: 3000000, duration: 1500000, text: { text: 'world', length: 5 } },
      ],
    });
    toStreamSpy.mockReturnValue({
      audioStream: streamOf(Buffer.from([0x49, 0x44, 0x33])),
      metadataStream: streamOf(Buffer.from(meta)),
    });

    const result = await synthesizeSpeech('hello world');

    // 100-nanosecond ticks -> milliseconds.
    expect(result.wordBoundaries).toEqual([
      { text: 'Hello', offsetMs: 100, durationMs: 200 },
      { text: 'world', offsetMs: 300, durationMs: 150 },
    ]);
  });

  it('still succeeds when the metadata stream is missing', async () => {
    toStreamSpy.mockReturnValue({ audioStream: streamOf(Buffer.from([0x49, 0x44, 0x33])) });

    const result = await synthesizeSpeech('hello');

    expect(result.wordBoundaries).toEqual([]);
  });

  it('throws a clear error when no audio chunks are emitted, still closing', async () => {
    toStreamSpy.mockReturnValue({ audioStream: streamOf(), metadataStream: null });

    await expect(synthesizeSpeech('hello')).rejects.toThrow('Edge TTS returned no audio.');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('propagates setMetadata failures and still closes', async () => {
    setMetadataSpy.mockRejectedValue(new Error('websocket boom'));

    await expect(synthesizeSpeech('hello')).rejects.toThrow('websocket boom');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('propagates toStream failures and still closes', async () => {
    setMetadataSpy.mockResolvedValue(undefined);
    toStreamSpy.mockImplementation(() => {
      throw new Error('no connection');
    });

    await expect(synthesizeSpeech('hello')).rejects.toThrow('no connection');
    expect(closeSpy).toHaveBeenCalled();
  });
});

describe('parseWordBoundariesChunk', () => {
  it('returns [] on malformed JSON', () => {
    expect(parseWordBoundariesChunk('not json')).toEqual([]);
  });

  it('returns [] when the document has no Metadata array', () => {
    expect(parseWordBoundariesChunk('{"foo": 1}')).toEqual([]);
  });

  it('skips non-word-boundary entries', () => {
    const out = parseWordBoundariesChunk(
      JSON.stringify({
        Metadata: [{ type: 'SentenceBoundary', offset: 1, duration: 2, text: { text: 'X', length: 1 } }],
      }),
    );
    expect(out).toEqual([]);
  });
});
