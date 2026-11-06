# 12 — Voice (`electron/voice/*`)

Text-to-speech and speech-to-text. Fully optional; degrades gracefully when
the OS/local tools are missing.

## `tts.ts`
- `synthesizeSpeech(text)` → `SynthesisResult` — text-to-speech via
  **msedge-tts** (Edge neural voices). Returns `{ audioBase64, mimeType }` so
  the renderer can play it without touching the filesystem. Errors come back
  as `{ error: string }`. Used by the pill's "speak the answer" control.

## `transcribe.ts`
- `transcribeAudio(audioBase64, mimeType, opts?)` — speech-to-text router for
  the **local sidecar first**, cloud fallback (engine honored from Settings:
  `'local'` | `'cloud'` | `'auto'`). `opts`:
  - `prompt?: string` — running live transcript (or domain context) fed to
    Whisper's `initial_prompt`: sentence context fights hallucinations and
    pins the language for multilingual sessions.
  - `fast?: boolean` — true for interim live chunks (sidecar uses beam_size=1);
    false for the authoritative final tail (beam_size=5).
  - Cloud fallback ignores `opts`; the `voiceLanguage` setting still pins the
    spoken language end-to-end.

## `local-stt.ts`
Local, private speech-to-text via a **faster-whisper sidecar**.
- `SttStatus` — `{ phase: 'idle'|'downloading'|'installing'|'ready'|'unavailable', progress, model }`
  for the renderer's voice-input indicator (the capsule shows a tiny progress
  bar while the model downloads/installs on first use).
- `startLocalStt()` — best-effort startup: spawns the Python sidecar
  (`scripts/install-stt.js` sets it up); returns false if python/script is
  missing (the app then uses cloud STT transparently). Also used by the
  `voice:stt-warm` IPC so the model load happens behind the mic-permission
  prompt.
- `transcribeLocal(audioBase64, mimeType, language?, prompt?, fast=false)` —
  transcribe via the sidecar; the Whisper model loads **lazily on first use**.
- `isLocalSttAvailable()` / `getSttStatus()` / `stopLocalStt()`.

## `local-whisper.py`
Flask sidecar (127.0.0.1:5100). `GET /health`, `POST /transcribe` with query
params `language`, `prompt`, `fast`. Two-speed decoding: `fast=1` →
`beam_size=1` (interim live chunks; speed wins), default → `beam_size=5`
(authoritative tail; accuracy wins). `vad_filter` and
`condition_on_previous_text=False` (prevents language drift mid-text) stay on.

## Phase 7 flow — tail-finalization (`renderer/hooks/useVoiceInput.ts`)
Speed, accuracy, multilingual all come from one redesign: **we stopped
re-transcribing the full recording on stop**.
1. User holds the mic button; `start()` fires `voice:stt-warm` immediately
   (sidecar spawn + model load overlap the mic-permission prompt), then probes
   `SttStatus.ready` a few times to decide if live chunking is on.
2. While recording, MediaRecorder slices every 1500ms (`requestData`); each
   live slice is transcribed with `fast: true` + the running text as `prompt`,
   then **stitched** into the live transcript via `mergeTranscript`
   (`renderer/lib/voiceMerge.ts` — boundary-aware: a word cut at a slice edge
   dedupes into its completed form instead of stuttering).
3. On stop, only the **last two slices** (the in-flight live slice + the stop
   delta, ≤ ~3s) are transcribed — `fast: false`, still context-prompted — and
   merged. One final transcript is delivered. No full-length duplicate pass, so
   a voice question submits at the speed of one tiny window.
4. Legacy full-blob path remains for: live mode disabled (cloud-only STT,
   model still downloading, no live text available) and the first-run model
   download case — `useVoiceInput` falls back to it automatically.
5. Errors surface as `__error__:`-prefixed strings from the IPC layer;
   `mergeTranscript` handles empty pieces, punctuation, casing, and multi-word
   overlap (see `tests/voiceMerge.test.ts`).

See also [14-renderer.md](14-renderer.md) (`useVoiceInput`, `useTTS`),
[16-build.md](16-build.md) (the `install-stt` script).