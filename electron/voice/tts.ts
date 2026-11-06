import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// Text-to-speech via Microsoft Edge's free Read Aloud service (no API key).
// The same engine/voice the WhatsApp RAG bot uses (edge_tts, en-US-AriaNeural).
// Returns base64-encoded MP3 audio plus word-boundary metadata (offsetMs /
// durationMs per spoken word) so the renderer can highlight each word as it is
// spoken and click-to-seek into the middle of the reading.

const VOICE = 'en-US-AriaNeural';

export type WordBoundaryInfo = {
  text: string;
  offsetMs: number;
  durationMs: number;
};

export type SynthesisResult = {
  audioBase64: string;
  mimeType: string;
  wordBoundaries: WordBoundaryInfo[];
};

// Parse one metadataStream document. msedge-tts emits objects shaped
// { Metadata: [ { type: 'WordBoundary', offset, duration, text: {text,...} }, ... ] }
// with offset/duration in 100-nanosecond ticks. Returns only the WordBoundary
// entries; anything malformed is skipped so a metadata hiccup never fails the
// synthesis itself.
export function parseWordBoundariesChunk(line: string): WordBoundaryInfo[] {
  try {
    const parsed = JSON.parse(line);
    const list = Array.isArray(parsed) ? parsed : parsed?.Metadata;
    if (!Array.isArray(list)) return [];
    const out: WordBoundaryInfo[] = [];
    for (const item of list) {
      if (item?.type === 'WordBoundary' && item?.text && typeof item.text.text === 'string') {
        out.push({
          text: item.text.text,
          offsetMs: Math.round((item.offset ?? 0) / 10000),
          durationMs: Math.round((item.duration ?? 0) / 10000),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function synthesizeSpeech(text: string): Promise<SynthesisResult> {
  if (!text.trim()) throw new Error('Nothing to read aloud.');
  const trimmed = text.trim().slice(0, 4000);
  console.log(`[tts] synthesizeSpeech start: text=${text.length} chars, voice=${VOICE}`);

  const tts = new MsEdgeTTS();
  try {
    console.log('[tts] connecting to Edge Read Aloud service...');
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: true,
    });
    const { audioStream, metadataStream } = await tts.toStream(trimmed);
    const chunks: Buffer[] = [];
    const wordBoundaries: WordBoundaryInfo[] = [];
    // Word-boundary metadata arrives as JSON docs on the metadata stream (one
    // doc per websocket metadata message — the same shape the library itself
    // consumes for toFile). Flow the stream with 'data' events, NOT an async
    // iterator: the library destroys the metadata stream the moment the audio
    // stream closes, and an in-flight iterator then rejects with
    // ERR_STREAM_PREMATURE_CLOSE before it has read the buffered documents.
    const metadataTask = new Promise<void>((resolve, reject) => {
      if (!metadataStream) {
        resolve();
        return;
      }
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      metadataStream.on('data', (chunk) => {
        const s = (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString('utf8').trim();
        if (s) wordBoundaries.push(...parseWordBoundariesChunk(s));
      });
      metadataStream.on('error', (e) => done(e));
      metadataStream.on('end', () => done());
      metadataStream.on('close', () => done());
    });
    for await (const chunk of audioStream as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    // Safety net: if the metadata stream ever fails to end cleanly (destroyed
    // streams normally close it after the audio ends), don't hang the reply.
    // unref() so a pending fallback timer never keeps the process alive.
    const metadataTimeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      t.unref();
    });
    await Promise.race([metadataTask, metadataTimeout]).catch((err) =>
      console.warn('[tts] metadata stream error:', err),
    );
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) throw new Error('Edge TTS returned no audio.');
    console.log(
      `[tts] received ${buf.length} bytes of MP3 audio, ${wordBoundaries.length} word boundaries`,
    );
    return { audioBase64: buf.toString('base64'), mimeType: 'audio/mpeg', wordBoundaries };
  } catch (err) {
    console.error('[tts] Edge TTS failed:', err instanceof Error ? err.message : err);
    throw err;
  } finally {
    tts.close();
    console.log('[tts] connection closed');
  }
}
