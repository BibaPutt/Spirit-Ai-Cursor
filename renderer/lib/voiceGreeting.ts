// Voice feedback for Spirit AI — short canned phrases spoken via the Edge TTS
// pipeline. The browser's Web Speech (OS SAPI "robot") voices are never used.
// To keep these phrases feeling instantaneous (no waiting on a network round-
// trip at submit time), the phrases are PRE-SYNTHESIZED through Edge and their
// audio is cached in memory: primeVoiceFeedback() warms the cache when voice
// mode arms, and speakAcknowledge() plays the cached blob right away. If a
// synthesis or decode fails, feedback is simply SILENT — no error is spoken.

import { ipc } from './ipc';

const ACKNOWLEDGES = [
  'Okay. Working on it.',
  'Got it. On it.',
  'Alright. Give me a moment.',
  'Sure thing. Processing now.',
  'On it. One moment please.',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

type CachedAudio =
  | { audioBase64: string; mimeType: string }
  | { error: true };

// Per-phrase in-flight synthesis promise, so a speak that arrives before
// priming finished awaits the same request instead of duplicating it.
const pending = new Map<string, Promise<CachedAudio>>();
// Decoded object URLs, built lazily on first play and reused after.
const urls = new Map<string, string>();
let priming = false;

function synthesize(phrase: string): Promise<CachedAudio> {
  const existing = pending.get(phrase);
  if (existing) return existing;
  const p = ipc.synthesizeSpeech(phrase).then((r) =>
    'error' in r ? { error: true as const } : r,
  );
  pending.set(phrase, p);
  return p;
}

/** Where the mp3 for a phrase lives once its synthesis resolves. */
async function audioUrlFor(phrase: string): Promise<string | null> {
  const cached = urls.get(phrase);
  if (cached) return cached;
  try {
    const r = await synthesize(phrase);
    if ('error' in r) return null;
    const bytes = Uint8Array.from(atob(r.audioBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: r.mimeType }));
    urls.set(phrase, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Warm the cache by synthesizing every canned phrase in the background. Safe
 * to call repeatedly (idempotent, fire-and-forget). Called when voice mode
 * arms so a later speakAcknowledge() finds its audio already in memory.
 */
export function primeVoiceFeedback(): void {
  if (priming) return;
  priming = true;
  for (const phrase of ACKNOWLEDGES) void synthesize(phrase);
}

let current: HTMLAudioElement | null = null;
let playSeq = 0;

/** Stop any in-flight feedback phrase immediately. */
export function cancelVoiceFeedback(): void {
  playSeq++;
  if (current) {
    const el = current;
    current = null;
    el.pause();
    try { el.src = ''; } catch { /* ignore */ }
  }
}

/**
 * Speak a random acknowledgment from the pre-synthesized cache. Used when a
 * prompt is submitted in audio mode to confirm the request was received.
 * Resolves when the phrase stops (or immediately if the audio is unusable —
 * failures are silent, never spoken).
 */
export async function speakAcknowledge(): Promise<void> {
  cancelVoiceFeedback();
  const url = await audioUrlFor(pick(ACKNOWLEDGES));
  if (!url) return;
  const seq = playSeq;
  await new Promise<void>((resolve) => {
    const el = new Audio(url);
    current = el;
    const done = () => {
      if (current === el) current = null;
      resolve();
    };
    const safety = setTimeout(done, 10_000);
    el.onended = () => { clearTimeout(safety); done(); };
    el.onerror = () => { clearTimeout(safety); done(); };
    el.onpause = () => {
      // We cancelled/stopped while playing — behave like a finished phrase.
      clearTimeout(safety); done();
    };
    void el.play().catch(() => { clearTimeout(safety); done(); });
    if (seq !== playSeq) {
      el.pause();
      clearTimeout(safety); done();
    }
  });
}