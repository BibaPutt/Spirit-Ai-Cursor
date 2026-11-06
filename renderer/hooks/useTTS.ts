// TTS hook with play/pause toggle and word-level tracking. Edge TTS ONLY —
// the browser's Web Speech (OS SAPI) "robot" voices are never used, not even
// as a fallback: if Edge synthesis fails the playback just errors silently.
// Playback state machine: idle → loading → playing ⇄ paused → idle/error.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import { stripMarkdownForTTS } from '../lib/ttsText';
import { alignBoundaries, splitWords } from '../lib/ttsWords';
import type { WordTime, WordToken } from '../lib/ttsWords';

type PlaybackState = 'idle' | 'loading' | 'speaking' | 'held' | 'error';

export type UseTTSOptions = {
  // Playback rate for the audio element.
  rate?: number;
};

export function useTTS(options: UseTTSOptions = {}) {
  const [playState, setPlayState] = useState<PlaybackState>('idle');
  const [error, setError] = useState<string | null>(null);
  // Words of the currently-spoken (cleaned) text plus the index of the word
  // being spoken right now (-1 = not started). Drives the reading view.
  const [words, setWords] = useState<WordToken[]>([]);
  const [activeWord, setActiveWord] = useState(-1);
  const rate = options.rate ?? 1.0;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // Monotonic token bumped on every stop/new-speak. After an awaited IPC
  // resolves we compare; if it changed the user aborted and we must not
  // start a new audio element.
  const generationRef = useRef(0);
  const stateRef = useRef<PlaybackState>(playState);
  useEffect(() => { stateRef.current = playState; }, [playState]);

  const wordsRef = useRef<WordToken[]>([]);
  const wordTimesRef = useRef<WordTime[]>([]);

  const teardown = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.src = '';
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    generationRef.current++;
    teardown();
    setPlayState('idle');
    setWords([]);
    setActiveWord(-1);
  }, [teardown]);

  // Pause playback — holds the current position.
  const pause = useCallback(() => {
    const el = audioRef.current;
    if (el && !el.paused) {
      el.pause();
      setPlayState('held');
    }
  }, []);

  // Resume from the held position.
  const resume = useCallback(() => {
    const el = audioRef.current;
    if (el && el.paused && el.src) {
      void el.play().catch(() => undefined);
      setPlayState('speaking');
    }
  }, []);

  const speak = useCallback(async (text: string) => {
    // Always restart — pause/resume is handled by the dedicated methods.
    if (stateRef.current === 'speaking' || stateRef.current === 'loading' || stateRef.current === 'held') {
      generationRef.current++;
      teardown();
    }
    const myGen = ++generationRef.current;
    setError(null);
    setPlayState('loading');
    console.log(`[tts] speak() gen=${myGen} len=${text.length}`);

    const clean = stripMarkdownForTTS(text);
    if (!clean) {
      console.warn('[tts] nothing to read after stripping markdown');
      setError('Nothing to read');
      setPlayState('error');
      return;
    }
    const toks = splitWords(clean);
    wordsRef.current = toks;
    setWords(toks);
    setActiveWord(-1);
    wordTimesRef.current = [];
    console.log(`[tts] stripped=${clean.length} chars, ${toks.length} words, calling ipc`);

    try {
      const result = await ipc.synthesizeSpeech(clean);
      if (myGen !== generationRef.current) return;
      if ('error' in result) {
        // No Web Speech fallback — the OS robot voice is never spoken. Just
        // surface the failure and stay silent.
        console.error(`[tts] Edge TTS failed: ${result.error}`);
        setError('Speech unavailable');
        setPlayState('error');
        return;
      }
      const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audio.playbackRate = rate;
      wordTimesRef.current = alignBoundaries(toks, result.wordBoundaries ?? []);
      // Dedup: both onerror and rejected play() can fire for the same failure.
      let claimed = false;
      audio.onended = () => {
        if (claimed) return;
        claimed = true;
        if (myGen !== generationRef.current) return;
        teardown();
        setPlayState('idle');
      };
      audio.onerror = () => {
        if (claimed) return;
        claimed = true;
        if (myGen !== generationRef.current) return;
        teardown();
        console.error('[tts] audio element failed — Edge TTS result unusable');
        setError('Playback failed');
        setPlayState('error');
      };
      audioRef.current = audio;
      try {
        await audio.play();
      } catch (e) {
        if (claimed) return;
        claimed = true;
        console.error('[tts] play() rejected:', e instanceof Error ? e.message : e);
        if (myGen !== generationRef.current) return;
        teardown();
        setError('Playback failed');
        setPlayState('error');
        return;
      }
      if (myGen !== generationRef.current) {
        audio.pause();
        return;
      }
      setActiveWord(0);
      setPlayState('speaking');
    } catch (e) {
      if (myGen !== generationRef.current) return;
      console.error('[tts] edge synthesis threw:', e instanceof Error ? e.message : e);
      setError('Speech unavailable');
      setPlayState('error');
    }
  }, [teardown, rate]);

  // Click-to-seek: restart playback from word `index`.
  const seekToWord = useCallback((index: number) => {
    const toks = wordsRef.current;
    if (toks.length === 0 || index < 0 || index >= toks.length) return;
    const el = audioRef.current;
    if (!el || !el.src) return;
    const times = wordTimesRef.current;
    let offsetMs: number | null = times[index]?.startMs ?? null;
    if (offsetMs === null) {
      for (let i = index - 1; i >= 0; i--) {
        if (times[i]) { offsetMs = times[i]!.startMs; break; }
      }
    }
    if (offsetMs === null && toks.length > 0 && typeof el.duration === 'number' && el.duration > 0 && isFinite(el.duration)) {
      offsetMs = (index / toks.length) * el.duration * 1000;
    }
    if (offsetMs !== null) {
      try { el.currentTime = offsetMs / 1000; } catch { /* noop */ }
    }
    if (el.paused) void el.play().catch(() => undefined);
    setActiveWord(index);
    setPlayState('speaking');
  }, []);

  // Audio-path word tracking: poll audio.currentTime each frame and highlight
  // the word whose boundary window it falls in.
  useEffect(() => {
    if (playState !== 'speaking') return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (!el || el.paused) return;
      const times = wordTimesRef.current;
      const toks = wordsRef.current;
      let idx = -1;
      const hasTimes = times.length > 0 && times.some((wt) => wt !== null);
      if (hasTimes) {
        const t = el.currentTime * 1000;
        for (let i = 0; i < times.length; i++) {
          const wt = times[i];
          if (wt && wt.startMs <= t) idx = i;
          else if (wt && wt.startMs > t) break;
        }
      } else if (toks.length > 0 && typeof el.duration === 'number' && el.duration > 0 && isFinite(el.duration)) {
        idx = Math.min(toks.length - 1, Math.floor((el.currentTime / el.duration) * toks.length));
      }
      if (idx < 0) idx = 0;
      setActiveWord((prev) => (prev === idx ? prev : idx));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playState]);

  useEffect(() => () => { generationRef.current++; teardown(); }, [teardown]);

  // Map internal state to the public API shape (consumers expect 'playing'/'paused').
  const state = playState === 'speaking' ? 'playing' as const
    : playState === 'held' ? 'paused' as const
    : playState as 'idle' | 'loading' | 'error';

  return { state, error, speak, stop, pause, resume, words, activeWord, seekToWord };
}