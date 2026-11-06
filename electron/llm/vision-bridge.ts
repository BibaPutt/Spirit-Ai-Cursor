// Vision bridge — gives TEXT-ONLY models a way to "see" the screen through a
// separate vision-capable endpoint. A local llama.cpp model without an mmproj
// cannot accept image input at all ("image input is not supported ... provide
// the mmproj"), so instead of sending pixels to it we have a configured cloud
// or local vision model DESCRIBE the screenshot and inject that description as
// plain text — the same information content, no image tokens, no hard failure.
//
// Two independent uses:
//   1. Submit-time readback (handlers.ts): when the answering model is
//      text-only and the user's question is screen-relevant, the bridge
//      describes the turn's screenshot and the text rides into the prompt
//      like the OCR readback does (they're combined).
//   2. describe_region tool (tools/describe-region.ts): the agent can crop a
//      region of the current screenshot and ask the bridge to read it —
//      useful when OCR can't capture a button, icon or chart. The tool is
//      gated in the router so it's only exposed when the bridge is enabled.
//
// Target resolution (resolveBridgeTarget):
//   - Manual override: the user's visionBridgeUrl + visionBridgeModel + the
//     encrypted vision bridge key. Any OpenAI-compatible server (LM Studio,
//     llama.cpp with mmproj, Ollama, vLLM, a cloud gateway, ...).
//   - Auto: the FIRST enabled cloud provider with a stored key, using the
//     provider's own picked model and the provider's OpenAI-compatible base.
//     Only OpenAI-compatible providers qualify (anthropic's /v1/messages wire
//     format is different). The ordering mirrors the router shortlist.

import sharp from 'sharp';
import {
  getLocalAiConfig,
  getSettingsLight,
  getDecryptedProviderKey,
  getVisionBridgeKey,
  hasProviderKey,
  hasVisionBridgeKey,
} from '../store/settings';
import { getProvider } from './providers/registry';
import { resolveOpenAIEndpoint } from './providers/localai';
import type { ProviderId, RequestRequirements } from './providers/types';

export type VisionBridgeTarget = {
  // Full chat/completions endpoint the bridge posts to.
  chatCompletionsUrl: string;
  apiKey: string;
  model: string;
  // Human-readable source for logs ("manual vision bridge", "OpenRouter").
  label: string;
};

// OpenAI-compatible cloud bases for AUTO resolution, in the same order the
// router would fall back through. Endpoints are spelled in full (no /v1
// normalization — gemini's compat base already ends in its own path).
const AUTO_TARGETS: { provider: ProviderId; chatCompletionsUrl: string }[] = [
  { provider: 'openrouter', chatCompletionsUrl: 'https://openrouter.ai/api/v1/chat/completions' },
  { provider: 'openai', chatCompletionsUrl: 'https://api.openai.com/v1/chat/completions' },
  // Gemini's OpenAI-compatible gateway: https://ai.google.dev/gemini-api/docs/openai
  { provider: 'gemini', chatCompletionsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
];

const BRIDGE_TIMEOUT_MS = 6000;
const BRIDGE_MAX_TOKENS = 600;
const BRIDGE_DESCRIPTION_CHAR_CAP = 1500;
// Cap the submit-time readback so a slow bridge never delays the first token
// past what the user would tolerate; the turn proceeds OCR-only if it loses.
export const SUBMIT_TIMEOUT_MS = 5500;

const BRIDGE_SYSTEM_PROMPT =
  'You are a screen reader working for another (text-only) assistant that cannot see images. ' +
  'Describe what is on the screen so that assistant can act on the user\'s request. ' +
  'Report concrete, exact UI text: button labels, menu items, file names, numbers, error messages, titles. ' +
  'Mention visible state (selected, hovered, checked, disabled, busy) and rough layout. ' +
  'Do not speculate about intent; describe what is actually visible. Be concise and factual.';

// Whether the user has switched the vision bridge on AND a usable target
// exists. Cheap (no decryption beyond a ciphertext presence check) — safe for
// the hot paths (tool filtering, submit-time gating).
export function isVisionBridgeEnabled(): boolean {
  const cfg = getLocalAiConfig();
  if (cfg.useVisionBridge !== true) return false;
  return targetAvailable();
}

function targetAvailable(): boolean {
  const cfg = getLocalAiConfig();
  const manual =
    (cfg.visionBridgeUrl ?? '').trim() &&
    (cfg.visionBridgeModel ?? '').trim() &&
    hasVisionBridgeKey();
  if (manual) return true;
  const light = getSettingsLight();
  for (const t of AUTO_TARGETS) {
    const pc = light.providers[t.provider];
    if (!pc || !pc.enabled) continue;
    if (!hasProviderKey(t.provider)) continue;
    return true;
  }
  return false;
}

// Resolve the bridge target the bridge should actually call RIGHT NOW. Costs
// exactly one key decryption (the chosen source's); returns null when the
// bridge is disabled or nothing usable is configured.
export function resolveBridgeTarget(): VisionBridgeTarget | null {
  const cfg = getLocalAiConfig();
  if (cfg.useVisionBridge !== true) return null;
  const manualUrl = (cfg.visionBridgeUrl ?? '').trim();
  const manualModel = (cfg.visionBridgeModel ?? '').trim();
  if (manualUrl && manualModel) {
    const key = getVisionBridgeKey();
    if (key) {
      return {
        chatCompletionsUrl: `${resolveOpenAIEndpoint(manualUrl)}/chat/completions`,
        apiKey: key,
        model: manualModel,
        label: 'manual vision bridge',
      };
    }
  }
  const light = getSettingsLight();
  const req: RequestRequirements = {
    web: false,
    vision: true,
    allowTools: true,
    tier: 'capable',
  };
  for (const t of AUTO_TARGETS) {
    const pc = light.providers[t.provider];
    if (!pc || !pc.enabled) continue;
    const key = getDecryptedProviderKey(t.provider);
    if (!key) continue;
    const model = getProvider(t.provider).pickModel(req);
    if (!model) continue;
    return {
      chatCompletionsUrl: t.chatCompletionsUrl,
      apiKey: key,
      model,
      label: t.provider === 'openrouter' ? 'OpenRouter' : t.provider === 'openai' ? 'OpenAI' : 'Gemini',
    };
  }
  return null;
}

export type DescribeOptions = {
  timeoutMs?: number;
  maxTokens?: number;
};

// Have the bridge describe a screenshot (or a region crop). Returns the
// bridge's description text, or null when the bridge is unconfigured, the
// call fails, or the model returns nothing usable — callers then fall back to
// OCR-only (never a hard error).
export async function describeScreenshot(
  imageB64: string,
  focusHint?: string,
  opts: DescribeOptions = {},
): Promise<string | null> {
  const target = resolveBridgeTarget();
  if (!target) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs ?? BRIDGE_TIMEOUT_MS);
  try {
    const focus = focusHint && focusHint.trim() ? ` Focus on: ${focusHint.trim()}` : '';
    const body = {
      model: target.model,
      messages: [
        { role: 'system', content: BRIDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Describe what is visible in this screenshot.${focus}`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageB64}` },
            },
          ],
        },
      ],
      max_tokens: opts.maxTokens ?? BRIDGE_MAX_TOKENS,
      stream: false,
    };
    const res = await fetch(target.chatCompletionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[vision-bridge] ${target.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
      return null;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return text.slice(0, BRIDGE_DESCRIPTION_CHAR_CAP);
  } catch (err) {
    console.warn(
      `[vision-bridge] ${target.label} describe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Crop a rectangular region out of a base64 image (jpeg re-encode). Used by
// describe_region so the agent can re-read a specific area instead of the
// whole frame. The coordinates are IMAGE pixels of imageB64. Returns null on
// any decode/crop failure — callers degrade gracefully.
export async function cropRegionB64(
  imageB64: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<string | null> {
  try {
    const meta = await sharp(Buffer.from(imageB64, 'base64')).metadata();
    if (!meta.width || !meta.height) return null;
    const left = Math.max(0, Math.min(Math.round(x), meta.width - 1));
    const top = Math.max(0, Math.min(Math.round(y), meta.height - 1));
    const width = Math.max(16, Math.min(Math.round(w), meta.width - left));
    const height = Math.max(16, Math.min(Math.round(h), meta.height - top));
    const out = await sharp(Buffer.from(imageB64, 'base64'))
      .extract({ left, top, width, height })
      .jpeg({ quality: 82 })
      .toBuffer();
    return out.toString('base64');
  } catch (err) {
    console.warn(
      `[vision-bridge] crop failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}