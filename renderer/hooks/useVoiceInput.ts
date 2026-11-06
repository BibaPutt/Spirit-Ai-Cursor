import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../lib/ipc';
import { mergeTranscript } from '../lib/voiceMerge';
import type { SttStatus } from '../../electron/types';

type State = 'idle' | 'recording' | 'transcribing' | 'error';

// Refresh cadence for the local-STT model-download status while a
// transcription is in flight. 600ms is smooth enough for a % counter
// without hammering IPC on every frame.
const STT_STATUS_POLL_MS = 600;

// Web Audio voice-activity detection. We auto-stop after the user has spoken
// at least once and then gone quiet — but "quiet" is judged SMART, not by a
// fixed timer: the live transcript decides. A sentence that ends with . ? or
// ! is done (short hold); a pause mid-sentence — remembering something,
// trailing off, filler words — gets a long hold. The "level" value is a 0..1
// RMS used by the UI to render a live waveform pulse.
//
// Thresholds tuned for macOS post-AGC (AGC stays ON in getUserMedia so
// quiet speakers still register). The earlier 0.018 silence floor was
// below macOS's typical ambient floor with AGC active, which meant
// silenceMs never accumulated and the auto-stop never fired — a
// regression surfaced in voice-first smoke testing.
// The fallback "no-speech-for-3s after first detection" guarantees
// auto-stop even if absolute thresholds drift on a noisy mic.
const SAMPLE_INTERVAL_MS = 60;
const SILENCE_THRESHOLD = 0.028;
const SPEECH_THRESHOLD = 0.045;
// Generous holds: normal between-word pauses must not cut the user off
// mid-sentence. 2s of quiet after speech = done; 3s without fresh speech
// (noisy mic floor) = done; 60s hard cap for long rambles.
//
// Smart stop (two tiers, picked from the live transcript at stop-check time):
//   END hold (2s)   — transcript ends with . ? ! → the sentence is done.
//   MID hold (6s)   — anything else: ends with a comma, a filler
//                     (uh/um/hmm/like), trails off (…), or STT is still
//                     catching up (empty transcript). The user is pausing
//                     mid-thought, remembering something — give them time.
// The no-speech fallback (8s) stays the outer net so a stuck session still
// ends even if thresholds drift on a noisy mic.
const SILENCE_HOLD_END_MS = 2000;
const SILENCE_HOLD_MID_MS = 6000;
const NO_SPEECH_FALLBACK_MS = 8000;
const MAX_RECORDING_MS = 60_000;
const SPEECH_DEBOUNCE_SAMPLES = 3;
const MIN_RECORDING_MS = 1500;

// Pseudo-live transcription: while recording we slice the audio every
// LIVE_CHUNK_MS via MediaRecorder.requestData() and transcribe each slice
// as it lands, appending text ~a second behind speech. Chunks are
// non-overlapping (requestData hands back the delta since the last call),
// so words cut at a boundary are stitched via mergeTranscript instead of
// naive concatenation.
//
// On stop we do NOT re-transcribe the full recording (that used to be the
// single biggest latency line: a whole-utterance STT pass you'd already paid
// for in live chunks). Instead (Phase 7 tail-finalization) only the LAST two
// slices are transcribed — the in-flight live slice + the stop delta — and
// merged into the accumulated live text. The answer path then runs at the
// speed of one ~3s window, not one full clip.
const LIVE_CHUNK_MS = 1200;
// Near-silent slices (opus VBR compresses silence hard) are skipped so we
// don't hammer the sidecar with empties while the user is thinking.
const LIVE_CHUNK_MIN_BYTES = 2000;
// A slice this small is opus-compressed silence — a tail worth skipping.
const TAIL_MIN_BYTES = 300;
// Tail-finalization transcribes the LAST two slices (the in-flight live slice
// plus the stop delta) so a live transcription killed by stop() can't lose the
// user's final words, and a word cut on a chunk boundary is always transcribed
// whole.
// A single live slice must never stall the stream: if a cloud/sidecar call
// hangs, liveInFlightRef would stay true and every later slice is skipped.
// The watchdog releases the gate after SLICE_TIMEOUT_MS so live text keeps
// flowing (10s — long enough for a slow local model on a 1.2s slice, short
// enough that one hung call can't freeze mid-sentence transcription).
const SLICE_TIMEOUT_MS = 10_000;
const TAIL_WINDOW_SLICES = 2;
const SLICE_TIMEOUT_ERR = `live slice timed out after ${SLICE_TIMEOUT_MS}ms`;

// True when the transcript reads as a finished sentence: ends with a
// sentence-terminal mark (trailing quotes/brackets ignored). Multilingual:
// ASCII . ? ! plus Hindi danda (।), CJK 。？！, Arabic ؟, Armenian ՞, etc.
// Ellipsis, commas, filler words (uh/um/hmm/like), or an empty transcript
// (STT still catching up) all count as mid-thought — the user paused, not
// finished. Transcription itself is language-free (Whisper auto-detects, or
// the pinned voice language); only this stop rule needs the mark list.
const SENTENCE_END_RE = /[.?!।。？！؟՞՜։]\s*$/u;
function sentenceLooksDone(text: string): boolean {
  const t = text.trim().replace(/['")\]]+$/, '');
  if (!t) return false;
  if (/(\.{3}|…)\s*$/.test(t)) return false;
  if (/\b(uh+|um+|hmm+|erm+|like|you know)\W*$/i.test(t)) return false;
  return SENTENCE_END_RE.test(t);
}

// Micro-detail: while the mic is arming (warm STT kick + the OS permission
// prompt, up to ~2s) there's no analyser yet — the capsule would sit frozen.
// We synthesize a slow "breathing" meter instead so Listening… visibly reacts
// from the FIRST frame, then hand off to the real RMS samples the moment the
// audio graph is live.
const ARM_METER_MS = 120;

export function useVoiceInput() {
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  // Local STT model download/install status (first-run model download).
  // Populated by polling IPC while a transcription is in flight; the
  // capsule renders a tiny progress bar off this.
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const sttPollRef = useRef<number | null>(null);
  const liveTimerRef = useRef<number | null>(null);
  const armMeterRef = useRef<number | null>(null);
  // True once the microphone has actually been granted and MediaRecorder is
  // recording (post getUserMedia). Between an optimistic `recording` and this
  // flag, stop() is an early cancel that just teases the arm down instead of
  // waiting on a recorder that doesn't exist yet.
  const recordingStartedRef = useRef(false);
  const stoppedRef = useRef(false);
  // Bumped on every recording session so stale live-slice results (a chunk
  // still in flight when the user stops) can't overwrite the final text.
  const liveSessionRef = useRef(0);
  const liveInFlightRef = useRef(false);
  // Accumulated live transcription text — each chunk is STITCHED here (not
  // appended) so the user sees a growing, boundary-clean transcript.
  const liveTextRef = useRef('');
  // Language pinned for this recording session: the first confident
  // detection sticks for all later slices so per-slice auto-detect can't
  // flip-flop languages mid-sentence (the gibberish machine). Reset on start.
  const sessionLangRef = useRef<string | null>(null);
  // Peak mic RMS since the last slice was cut. The live branch skips slices
  // with no real speech in them — transcribing near-silence is what makes
  // Whisper invent unrelated phrases out of mic noise.
  const slicePeakRef = useRef(0);
  // Peak over the whole session. Final calls report it so main can flag a
  // muted/whisper-quiet mic instead of delivering a hallucination.
  const sessionPeakRef = useRef(0);
  // Set synchronously in the inactive dataavailable handler so onstop (which
  // fires right after) knows tail-finalization owns the session.
  const finalizingRef = useRef(false);

  const startSttPolling = () => {
    if (sttPollRef.current !== null) return;
    const poll = async () => {
      try {
        const s = await ipc.getSttStatus();
        if (sttPollRef.current === null) return;
        setSttStatus(s);
      } catch {
        /* preload may not expose it in older builds */
      }
    };
    void poll();
    sttPollRef.current = window.setInterval(poll, STT_STATUS_POLL_MS);
  };

  const stopSttPolling = () => {
    if (sttPollRef.current !== null) {
      window.clearInterval(sttPollRef.current);
      sttPollRef.current = null;
    }
    setSttStatus(null);
  };

  // Synthesized meter while the real audio graph is arming. Reads as a gentle
  // pulse so the first "Listening…" isn't dead-still; swaps itself off the
  // moment the analyser starts feeding real RMS values.
  const startArmingMeter = () => {
    if (armMeterRef.current !== null) return;
    const t0 = Date.now();
    armMeterRef.current = window.setInterval(() => {
      if (analyserRef.current) {
        stopArmingMeter();
        return;
      }
      const t = (Date.now() - t0) / 1000;
      setLevel(0.22 + Math.sin(t * 2.4) * 0.12);
    }, ARM_METER_MS);
  };
  const stopArmingMeter = () => {
    if (armMeterRef.current !== null) {
      window.clearInterval(armMeterRef.current);
      armMeterRef.current = null;
    }
  };

  const cleanup = () => {
    if (vadIntervalRef.current !== null) {
      window.clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    stopArmingMeter();
    stopSttPolling();
    if (audioCtxRef.current) {
      try {
        void audioCtxRef.current.close();
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    finalizingRef.current = false;
    setLevel(0);
  };

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    else if (!recordingStartedRef.current) {
      // Early cancel: the arm is still warming up (optimistic `recording`
      // state, MediaRecorder not created yet). Just tease the arm back down.
      stoppedRef.current = true;
      setState('idle');
      cleanup();
    } else {
      cleanup();
    }
  }, []);

  const start = useCallback(
    async (onTranscript: (text: string) => void, onLiveText?: (text: string) => void) => {
      setError(null);
      liveTextRef.current = '';
      sessionLangRef.current = null;
      slicePeakRef.current = 0;
      sessionPeakRef.current = 0;
      finalizingRef.current = false;
      recordingStartedRef.current = false;
      stoppedRef.current = false;
      // OPTIMISTIC START: flip to `recording` synchronously so the capsule
      // and mic toggle show the 3-bar Listening state on frame one, while the
      // arm work (warm STT kick + mic permission) happens underneath. The
      // breathing meter covers the warm-up window until real audio lands.
      setState('recording');
      startArmingMeter();
      console.log('[voice] start optimistic');
      try {
        // Kick the sidecar spawn + model load behind the mic-permission
        // prompt — but DON'T wait on it. Live slices route per-slice instead.
        void ipc.warmStt?.().catch(() => {});
        startSttPolling();
        // Invalidate any in-flight live slices from a previous session.
        liveSessionRef.current += 1;

        // Early-cancel happened while the arm was warming — don't request the
        // mic after the user already tapped stop.
        if (stoppedRef.current) return;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.fftSize);

        let hasSpoken = false;
        let silenceMs = 0;
        // Timestamp of the most recent above-SPEECH_THRESHOLD sample. The
        // fallback path uses this to stop recording after a fixed window
        // of "no fresh speech" even when the ambient floor never drops
        // below SILENCE_THRESHOLD (mic with constant hum etc).
        let lastSpeechTs = 0;
        // Consecutive above-SPEECH_THRESHOLD samples since the last quiet
        // one — speech is only confirmed after SPEECH_DEBOUNCE_SAMPLES.
        let speechStreak = 0;
        const startedAt = Date.now();

        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        const blobToBase64 = async (blob: Blob): Promise<string> => {
          const buffer = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < buffer.byteLength; i++) binary += String.fromCharCode(buffer[i]);
          return btoa(binary);
        };
        const rec = new MediaRecorder(stream, { mimeType: mime });
        chunksRef.current = [];

        // Tail-finalization: transcribe just the final window (the in-flight
        // live slice + the stop delta), stitch it onto the live text, and
        // deliver ONE final transcript. Runs once per session; owns cleanup.
        const finalizeLive = async (tailBlobs: Blob[], mimeType: string) => {
          finalizingRef.current = true;
          const session = liveSessionRef.current;
          setState('transcribing');
          let tail = '';
          let hadError = false;
          let quietMic = false;
          // Safety net: if NO live slice ever landed (sidecar still warming
          // with no cloud fallback, per-slice timeouts, etc.), transcribing
          // only the tail would silently drop the user's whole utterance.
          // Fall back to the FULL recording so their words are never lost —
          // slower, but complete.
          const needFull = liveTextRef.current.trim().length === 0;
          const blob = new Blob(needFull ? chunksRef.current : tailBlobs, { type: mimeType });
          const minBytes = needFull ? 1000 : TAIL_MIN_BYTES;
          if (blob.size >= minBytes) {
            try {
              const t0 = Date.now();
              const base64 = await blobToBase64(blob);
              const result = await ipc.transcribeAudio(base64, mimeType, {
                // The accumulated live text becomes Whisper's initial_prompt:
                // sentence context fights hallucinations and pins the
                // language for multilingual sessions.
                prompt: needFull ? undefined : liveTextRef.current,
                fast: false,
                language: sessionLangRef.current ?? undefined,
                voicePeak: sessionPeakRef.current,
              });
              console.log(
                `[voice] ${needFull ? 'full' : 'tail'} finalize ${Date.now() - t0}ms ${Math.round(blob.size / 1024)}KB "${result.text.slice(0, 60)}"`,
              );
              if (liveSessionRef.current !== session) return;
              if (!result.text.startsWith('__error__:')) {
                tail = result.text.trim();
                if (result.quiet) quietMic = true;
                if (!sessionLangRef.current && result.language) {
                  sessionLangRef.current = result.language;
                  console.log(`[voice] session language pinned: ${result.language}`);
                }
              } else hadError = true;
            } catch (err) {
              hadError = true;
              console.warn('[voice] finalize failed:', err);
            }
          }
          if (liveSessionRef.current !== session) return;
          if (tail) liveTextRef.current = mergeTranscript(liveTextRef.current, tail);
          const finalText = liveTextRef.current.trim();
          if (finalText) {
            console.log(`[voice] final "${finalText.slice(0, 80)}"`);
            if (onLiveText) onLiveText(finalText);
            onTranscript(finalText);
          } else {
            console.log('[voice] live path produced no text');
            if (quietMic) {
              // The mic caught ~nothing all session: say so instead of
              // showing a hallucination or a generic failure.
              setError('Mic sounds muted or way too quiet — check input volume and mic, then try again.');
              setState('error');
              cleanup();
              return;
            }
            if (hadError) {
              // Surface why the user hears silence: a broken STT path must
              // not look like "the mic doesn't work".
              setError('Transcription failed. Check STT in Settings → Voice.');
              setState('error');
              cleanup();
              return;
            }
          }
          setState('idle');
          cleanup();
        };

        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
          // requestData() fires a dataavailable while the recorder is STILL
          // recording (state 'recording'); the final stop fires with state
          // 'inactive'. Live slices are transcribed on the fly (fast beam,
          // context prompt) and stitched boundary-aware; the stop slice is
          // the tail-finalization trigger.
          if (rec.state === 'recording') {
            if (onLiveText && e.data.size >= LIVE_CHUNK_MIN_BYTES) {
              const slice = e.data;
              const session = liveSessionRef.current;
              // Energy gate BEFORE the in-flight gate: a slice with no real
              // speech never reaches the model, so silence can't come back
              // as invented words.
              const peak = slicePeakRef.current;
              slicePeakRef.current = 0;
              if (peak < SPEECH_THRESHOLD) {
                console.log(`[voice] live slice silent (peak ${peak.toFixed(3)}), skipping`);
                return;
              }
              if (liveInFlightRef.current) return;
              liveInFlightRef.current = true;
              void (async () => {
                try {
                  const t0 = Date.now();
                  const base64 = await blobToBase64(slice);
                  // Always route through the main transcribe router ('auto').
                  // Forcing 'cloud' while the sidecar warms used to fail
                  // offline users with "no API key" even though local STT was
                  // seconds from ready.
                  const engine: 'auto' = 'auto';
                  console.log(`[voice] live chunk ${Math.round(slice.size / 1024)}KB engine=${engine}`);
                  const req = ipc.transcribeAudio(base64, mime, {
                    prompt: liveTextRef.current,
                    fast: true,
                    engine,
                    language: sessionLangRef.current ?? undefined,
                  });
                  // Swallow the orphan's own rejection so the race below is
                  // the only place the outcome is acted on.
                  req.catch(() => {});
                  const result = await Promise.race([
                    req,
                    new Promise<{ text: string; language: string | null; quiet: boolean }>((_, reject) =>
                      window.setTimeout(() => reject(new Error(SLICE_TIMEOUT_ERR)), SLICE_TIMEOUT_MS),
                    ),
                  ]);
                  console.log(`[voice] live chunk done ${Date.now() - t0}ms "${result.text.slice(0, 60)}"`);
                  if (liveSessionRef.current !== session) return;
                  if (!sessionLangRef.current && result.language) {
                    sessionLangRef.current = result.language;
                    console.log(`[voice] session language pinned: ${result.language}`);
                  }
                  const text = result.text.startsWith('__error__:') ? '' : result.text.trim();
                  if (text) {
                    liveTextRef.current = mergeTranscript(liveTextRef.current, text);
                    onLiveText(liveTextRef.current);
                  }
                } catch (err) {
                  console.warn('[voice] live chunk failed:', err);
                } finally {
                  liveInFlightRef.current = false;
                }
              })();
            }
            return;
          }
          // Final stop slice — hand the session to tail-finalization. The last
          // two slices are captured synchronously so an in-flight live
          // transcription that never lands can't lose the final words.
          if (onLiveText && !finalizingRef.current) {
            const tailBlobs = chunksRef.current.slice(-TAIL_WINDOW_SLICES);
            void finalizeLive(tailBlobs, mime);
          }
        };

        rec.onstop = async () => {
          if (vadIntervalRef.current !== null) {
            window.clearInterval(vadIntervalRef.current);
            vadIntervalRef.current = null;
          }
          if (liveTimerRef.current !== null) {
            window.clearInterval(liveTimerRef.current);
            liveTimerRef.current = null;
          }
          if (onLiveText) {
            // Tail-finalization owns the session: the inactive dataavailable
            // already handed it to finalizeLive, which stitches the tail onto
            // the live text and delivers the one final transcript. Nothing to
            // do here but release the mic — re-transcribing the full recording
            // would duplicate work the live chunks already did (this used to
            // be the biggest wait before a voice question submitted).
            cleanup();
            return;
          }
          liveSessionRef.current += 1;
          setState('transcribing');
          startSttPolling();
          try {
            const blob = new Blob(chunksRef.current, { type: mime });
            console.log(`[voice] stop blob=${Math.round(blob.size / 1024)}KB chunks=${chunksRef.current.length} liveText="${liveTextRef.current.slice(0, 40)}"`);
            if (blob.size < 1000) {
              console.log('[voice] stop blob too small, dropping');
              setState('idle');
              cleanup();
              return;
            }
            const t0 = Date.now();
            const base64 = await blobToBase64(blob);
            const result = await ipc.transcribeAudio(base64, mime, {
              voicePeak: sessionPeakRef.current,
            });
            console.log(`[voice] final transcribe ${Date.now() - t0}ms len=${result.text.length}`);
            if (result.text.startsWith('__error__:')) {
              console.error('[voice] final error:', result.text);
              setError(result.text.slice('__error__:'.length));
              setState('error');
              cleanup();
              return;
            }
            if (result.text.trim()) {
              console.log(`[voice] final text "${result.text.trim().slice(0, 80)}"`);
              onTranscript(result.text.trim());
            } else if (result.quiet) {
              setError('Mic sounds muted or way too quiet — check input volume and mic, then try again.');
              setState('error');
              cleanup();
              return;
            } else {
              console.log('[voice] final empty');
            }
            setState('idle');
          } catch (err) {
            console.error('[voice] final exception:', err);
            setError(err instanceof Error ? err.message : 'Transcription failed');
            setState('error');
          } finally {
            cleanup();
          }
        };

        recorderRef.current = rec;
        rec.start();
        recordingStartedRef.current = true;

        if (onLiveText) {
          liveTimerRef.current = window.setInterval(() => {
            const r = recorderRef.current;
            if (r && r.state === 'recording') r.requestData();
          }, LIVE_CHUNK_MS);
        }

        vadIntervalRef.current = window.setInterval(() => {
          analyser.getByteTimeDomainData(data);
          // RMS around 128 midpoint.
          let sumSq = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / data.length);
          setLevel(Math.min(1, rms * 4));
          // Feed the per-slice energy gate (reset when each slice is cut)
          // and the session peak (reported with final calls for the
          // muted-mic warning).
          if (rms > slicePeakRef.current) slicePeakRef.current = rms;
          if (rms > sessionPeakRef.current) sessionPeakRef.current = rms;

          if (rms > SPEECH_THRESHOLD) {
            speechStreak += 1;
            if (speechStreak >= SPEECH_DEBOUNCE_SAMPLES) {
              hasSpoken = true;
              silenceMs = 0;
              lastSpeechTs = Date.now();
            }
          } else {
            speechStreak = 0;
            if (hasSpoken && rms < SILENCE_THRESHOLD) {
              silenceMs += SAMPLE_INTERVAL_MS;
            } else if (!hasSpoken) {
              silenceMs = 0;
            }
          }
          // Never auto-stop before MIN_RECORDING_MS: the user may still be
          // getting ready to speak, and the debounce above means we can't
          // even be "spoken" from a stray noise spike.
          const canAutoStop = Date.now() - startedAt >= MIN_RECORDING_MS;
          if (canAutoStop) {
            // Smart hold: finished sentence stops fast; a mid-thought pause
            // (remembering something, trailing off) gets the long hold.
            const holdMs = sentenceLooksDone(liveTextRef.current)
              ? SILENCE_HOLD_END_MS
              : SILENCE_HOLD_MID_MS;
            if (hasSpoken && silenceMs >= holdMs) {
              stop();
            }
            // Fallback path: even if the silence threshold never trips (mic
            // floor too high, AGC pumping the noise back up, etc), once
            // we've HEARD speech we honour a hard window — no fresh speech
            // for NO_SPEECH_FALLBACK_MS means the user is done. This is
            // what made voice-first feel "stuck" on macOS.
            if (hasSpoken && lastSpeechTs > 0 && Date.now() - lastSpeechTs >= NO_SPEECH_FALLBACK_MS) {
              stop();
            }
          }
        }, SAMPLE_INTERVAL_MS);

        maxTimerRef.current = window.setTimeout(() => stop(), MAX_RECORDING_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Microphone access denied');
        setState('error');
        cleanup();
      }
    },
    [stop],
  );

  useEffect(() => {
    return () => cleanup();
  }, []);

  return { state, error, level, sttStatus, start, stop };
}
