import { openRouterProvider } from './openrouter';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import { geminiProvider } from './gemini';
import { localaiProvider } from './localai';
import { opencodeProvider } from './opencode';
import { getSettingsLight } from '../../store/settings';
import type { ProviderClient, ProviderId, RequestRequirements } from './types';

// Fixed priority order: OpenRouter first, then the rest. Local AI sits last —
// it is a self-hosted fallback the user enables deliberately, not a default.
export const PROVIDER_ORDER: ProviderId[] = [
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'localai',
  'opencode',
];

const REGISTRY: Record<ProviderId, ProviderClient> = {
  openrouter: openRouterProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  localai: localaiProvider,
  opencode: opencodeProvider,
};

export function getProvider(id: ProviderId): ProviderClient {
  return REGISTRY[id];
}

export function getAllProviders(): ProviderClient[] {
  return PROVIDER_ORDER.map((id) => REGISTRY[id]);
}

// True when the FIRST resolvable provider's model can see images — i.e. the
// run will attach the screenshot and the model reads it directly. All the
// cloud defaults (Gemma 4, GPT-5 mini, Haiku, Gemini Flash) are vision-capable,
// so the common path can SKIP the full-screen OCR wall that previously blocked
// every first token. OCR only matters when the first resolvable model is
// text-only (a custom non-vision OpenAI/Gemini id or a vision-off local
// server), where it is the ONLY way the model can read the screen.
//
// Cheap and safe on the hot path: capability checks are model-id/config based
// and never decrypt keys, so this cannot fire a keychain prompt. Matches the
// router's provider-shortlist rules (enabled + key/baseUrl, in PROVIDER_ORDER).
export function wouldUseVisionModel(opts: {
  web?: boolean;
  tier?: 'fast' | 'capable';
} = {}): boolean {
  const light = getSettingsLight();
  const req: RequestRequirements = {
    web: opts.web ?? false,
    vision: true,
    allowTools: true,
    tier: opts.tier ?? 'fast',
  };
  for (const id of PROVIDER_ORDER) {
    const cfg = light.providers[id];
    if (!cfg || !cfg.enabled) continue;
    if (id === 'localai' || id === 'opencode') {
      if (!(cfg.baseUrl ?? '').trim()) continue;
    } else if (!cfg.hasKey) {
      continue;
    }
    // First resolvable provider decides the OCR need.
    return REGISTRY[id].supports('vision', req);
  }
  return false;
}
