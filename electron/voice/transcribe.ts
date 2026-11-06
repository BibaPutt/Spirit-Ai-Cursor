import { Buffer } from 'node:buffer';
import { getSettings } from '../store/settings';
import { applySttPostFilter } from './sttPostFilter';
import { HTTP_HEADERS_BASE } from '../llm/providers/types';
import {
  getLocalSttUnavailableReason,
  isLocalSttAvailable,
  startLocalStt,
  transcribeLocal,
} from './local-stt';

// Voice transcription. Engine routing honors settings.sttEngine:
//   'local' → the bundled faster-whisper sidecar only (offline, multilingual)
//   'cloud' → Gemini direct, then OpenAI Whisper, then OpenRouter
//   'auto'  → sidecar first, cloud fallback when it is missing/unhealthy

// Cloud transcription MUST fail fast, never dangle: a stuck network (proxy,
// VPN, blocked host) previously hung every live + final transcription
// forever ("Transcribing… for ages"), with no error ever surfacing. Every
// cloud fetch aborts via AbortSignal.timeout and reports which host was
// unreachable so the log + error pill say exactly what went wrong.
const CLOUD_TIMEOUT_MS = 30_000;
const LOCAL_TIMEOUT_MS = 45_000;

function hasCloudSttConfigured(): boolean {
  const settings = getSettings();
  return Boolean(
    (settings.providers.gemini?.enabled && settings.providers.gemini.apiKey) ||
      (settings.providers.openai?.enabled && settings.providers.openai.apiKey) ||
      (settings.providers.openrouter?.enabled && settings.providers.openrouter.apiKey),
  );
}

// fetch that rejects with a descriptive timeout error (instead of hanging)
// when the provider doesn't respond in time.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as DOMException | undefined)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      const host = new URL(url).host;
      throw new Error(
        `${host} timed out after ${Math.round(timeoutMs / 1000)}s — network to ${host} appears blocked or unreachable`,
      );
    }
    throw err;
  }
}

const LANGUAGE_LABEL: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  sv: 'Swedish',
  tr: 'Turkish',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
};

export interface TranscribeOptions {
  /** Running live transcript (or domain context) fed to Whisper's initial_prompt */
  prompt?: string;
  /** True for interim live chunks (beam_size=1); false for the authoritative tail */
  fast?: boolean;
  /**
   * Per-call engine override. When live slices pass `'cloud'`, this skips the
   * sidecar spawn+load stall so the chunk transcribes immediately and the UI
   * keeps streaming live text while the sidecar warms up. Defaults to
   * settings.sttEngine ('auto' probes local first, falls back to cloud).
   */
  engine?: 'auto' | 'local' | 'cloud';
  /**
   * Session-pinned language (2-letter). The renderer pins the first confident
   * detection for the rest of the recording so per-slice auto-detect can't
   * flip-flop languages mid-sentence. Falls back to settings.voiceLanguage.
   */
  language?: string;
  /**
   * Peak mic RMS (0..1) across the session. When the mic heard ~nothing the
   * transcript comes back flagged quiet so the UI can say "mic muted?"
   * instead of delivering a hallucination.
   */
  voicePeak?: number;
}

export interface TranscribeResult {
  text: string;
  /** Detected/pinned language code, or null when unknown (cloud path). */
  language: string | null;
  /** True when the mic peak says nothing was actually spoken. */
  quiet: boolean;
}

export async function transcribeAudio(
  audioBase64: string,
  mimeType: string,
  opts?: TranscribeOptions,
): Promise<TranscribeResult> {
  const t0 = Date.now();
  const settings = getSettings();
  const language =
    opts?.language ??
    (settings.voiceLanguage && settings.voiceLanguage !== 'auto' ? settings.voiceLanguage : undefined);
  const engine = opts?.engine ?? settings.sttEngine ?? 'auto';
  // Per-call running transcript wins; otherwise the user's Settings → Voice
  // context line ("I mix Hindi and English…") rides as initial_prompt.
  const prompt = opts?.prompt || settings.sttInitialPrompt || undefined;
  // Half the renderer's silence floor: below this the mic caught ~nothing.
  const quietMic =
    typeof opts?.voicePeak === 'number' && opts.voicePeak >= 0 && opts.voicePeak < 0.014;
  const chunkKB = Math.round((audioBase64.length * 3) / 4 / 1024);
  console.log(`[transcribe] start engine=${engine} lang=${language ?? 'auto'} chunk=${chunkKB}KB mime=${mimeType}`);

  if (engine === 'local' || engine === 'auto') {
    const started = await startLocalStt();
    if (started && isLocalSttAvailable()) {
      try {
        const result = await transcribeLocal(audioBase64, mimeType, language, prompt, opts?.fast);
        // Post-filter runs on FINAL text only (fast = live slices): spoken
        // punctuation, filler drop, personal word fixes.
        const text =
          opts?.fast === true
            ? result.text
            : applySttPostFilter(result.text, settings.sttWordOverrides);
        console.log(`[transcribe] local OK ${Date.now() - t0}ms lang=${result.language ?? '?'}${quietMic ? ' QUIET-MIC' : ''} "${text.slice(0, 80)}"`);
        return { text, language: result.language, quiet: quietMic };
      } catch (err) {
        console.warn(
          '[transcribe] local STT failed, falling back:',
          err instanceof Error ? err.message : err,
        );
        if (engine === 'local') {
          throw new Error(
            `Local STT failed: ${err instanceof Error ? err.message : 'unknown'}. ` +
              'You can switch to Cloud STT in Settings → Voice.',
          );
        }
      }
    } else if (engine === 'local') {
      throw new Error(
        'Local STT is not available. Run "npm i" to install it, or switch to Cloud STT in Settings → Voice.',
      );
    } else {
      // Engine 'auto', sidecar unavailable — say WHY instead of a bare
      // "routing to cloud" so a broken python/spawn is diagnosed at a glance.
      const reason = getLocalSttUnavailableReason() ?? 'sidecar not running';
      if (!hasCloudSttConfigured()) {
        throw new Error(
          reason === 'sidecar still starting'
            ? 'Local speech recognition is still starting. Wait a few seconds and try again.'
            : `Local STT unavailable (${reason}). Check Settings → Voice or run scripts/install-stt.ps1.`,
        );
      }
      console.log(`[transcribe] local unavailable (${reason}); routing to cloud`);
    }
  }

  console.log('[transcribe] routing to cloud');
  try {
    const result = await transcribeCloud(audioBase64, mimeType, language ?? null);
    console.log(`[transcribe] cloud OK ${Date.now() - t0}ms "${result.slice(0, 80)}"`);
    const text =
      opts?.fast === true ? result : applySttPostFilter(result, settings.sttWordOverrides);
    return { text, language: language ?? null, quiet: quietMic };
  } catch (err) {
    console.error('[transcribe] cloud FAILED:', err instanceof Error ? err.message : err);
    throw err;
  }
}

async function transcribeCloud(
  audioBase64: string,
  mimeType: string,
  language: string | null,
): Promise<string> {
  const settings = getSettings();

  if (settings.providers.gemini?.enabled && settings.providers.gemini.apiKey) {
    console.log('[transcribe] cloud provider: gemini');
    return transcribeWithGemini(audioBase64, mimeType, settings.providers.gemini.apiKey, language);
  }
  if (settings.providers.openai?.enabled && settings.providers.openai.apiKey) {
    console.log('[transcribe] cloud provider: openai');
    return transcribeWithOpenAI(audioBase64, mimeType, settings.providers.openai.apiKey, language);
  }
  if (settings.providers.openrouter?.enabled && settings.providers.openrouter.apiKey) {
    console.log('[transcribe] cloud provider: openrouter');
    return transcribeWithOpenRouterWhisper(
      audioBase64,
      mimeType,
      settings.providers.openrouter.apiKey,
      language,
    );
  }
  throw new Error(
    'No voice-capable provider configured. Add a Gemini, OpenAI, or OpenRouter key in /settings.',
  );
}

async function transcribeWithGemini(
  audioBase64: string,
  mimeType: string,
  apiKey: string,
  language: string | null,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    'gemini-2.5-flash',
  )}:generateContent`;
  const langHint = language
    ? `The audio is in ${LANGUAGE_LABEL[language] ?? language}. `
    : 'Detect the spoken language automatically. ';
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        ...HTTP_HEADERS_BASE,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${langHint}Transcribe this audio exactly into the same language as the speaker. Output only the transcribed text, no preamble, no translation.`,
              },
              { inlineData: { mimeType, data: audioBase64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.0, maxOutputTokens: 800 },
      }),
    },
    CLOUD_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Gemini transcribe ${res.status}: ${await res.text().catch(() => '')}`);
  const json = (await res.json()) as any;
  const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  return text.trim();
}

async function transcribeWithOpenAI(
  audioBase64: string,
  mimeType: string,
  apiKey: string,
  language: string | null,
): Promise<string> {
  const blob = new Blob([Buffer.from(audioBase64, 'base64')], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, `audio.${mimeType.split('/')[1]?.split(';')[0] || 'webm'}`);
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');
  if (language) form.append('language', language);

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': HTTP_HEADERS_BASE['User-Agent'],
      },
      body: form,
    },
    CLOUD_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`OpenAI transcribe ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.text()).trim();
}

async function transcribeWithOpenRouterWhisper(
  audioBase64: string,
  mimeType: string,
  apiKey: string,
  language: string | null,
): Promise<string> {
  // OpenRouter currently has no dedicated audio endpoint; fall back to using
  // the chat completions endpoint with a model that can transcribe via vision-
  // like inputs (gemini-2.5-flash via OR also accepts inline audio data URLs).
  const langHint = language
    ? `The audio is in ${LANGUAGE_LABEL[language] ?? language}. `
    : 'Detect the spoken language automatically. ';
  const res = await fetchWithTimeout(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...HTTP_HEADERS_BASE,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${langHint}Transcribe the audio exactly into the same language as the speaker. Output only the transcribed text.`,
              },
              {
                type: 'input_audio',
                input_audio: { data: audioBase64, format: mimeType.includes('webm') ? 'webm' : 'wav' },
              },
            ],
          },
        ],
        max_tokens: 800,
        temperature: 0.0,
      }),
    },
    CLOUD_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`OpenRouter transcribe ${res.status}: ${await res.text().catch(() => '')}`);
  const json = (await res.json()) as any;
  return (json?.choices?.[0]?.message?.content ?? '').trim();
}
