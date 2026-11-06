import { MAX_TOKENS, REASONING_EFFORT } from '../models';
import type { Message } from '../prompt';
import type { ToolDeclaration } from '../tools';
import {
  HTTP_HEADERS_BASE,
  ProviderHttpError,
  type ProviderClient,
  type ProviderRoundResult,
  type RequestRequirements,
} from './types';
import { parseOpenAIStream } from './openai-stream';

// OpenRouter routes to many underlying models. We pick the cheapest +
// fastest model that satisfies the request capabilities.
//
// Free variants only: the app needs BOTH vision (a screenshot is attached to
// every trigger) and tools (the agentic ui_read/ui_click flow). As of mid-2026
// the only free OpenRouter models with vision + tools are Google's Gemma 4
// family — there is no free Gemini 3. 26B A4B (MoE, ~3.8B active) is the fast
// everyday pick; 31B (dense) handles the "capable" tier and fallback.
//
// When a Gemma 4 request fails (rate-limit, temporary 5xx, or a deprecated
// model id), the round retries once on `openrouter/free`, OpenRouter's dynamic
// router that auto-picks a working free model for the request. The router
// model accepts no `reasoning` field, so the fallback body drops it.
const MODELS = {
  fast: 'google/gemma-4-26b-a4b-it:free',
  fastFallback: 'google/gemma-4-31b-it:free',
  capable: 'google/gemma-4-31b-it:free',
} as const;

// The openrouter/free dynamic router: auto-routes to whichever free model can
// serve the request. Used as an in-provider fallback.
const FREE_ROUTER_MODEL = 'openrouter/free';

// Errors that a different free model could plausibly fix. Auth failures
// (401/403) won't improve by switching models and are NOT retried.
const FALLBACK_STATUSES = new Set([408, 425, 429, 400]);
function canFallback(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && FALLBACK_STATUSES.has(err.status);
}

function applyOnlineSuffix(model: string, online: boolean): string {
  if (!online) return model;
  if (model.endsWith(':online')) return model;
  // Free variants have no :online plugin model on OpenRouter — use the base.
  if (model.endsWith(':free')) return model;
  return `${model}:online`;
}

export const openRouterProvider: ProviderClient = {
  id: 'openrouter',
  displayName: 'OpenRouter',

  pickModel(req) {
    const base = req.tier === 'capable' ? MODELS.capable : MODELS.fast;
    return applyOnlineSuffix(base, req.web);
  },

  supports() {
    // Gemma 4 (free) supports vision and tools; :online web is a no-op on
    // free variants (no such plugin model exists).
    return true;
  },

  async runRound(model, messages, apiKey, tools, signal, onChunk, onReasoning) {
    const attempt = async (m: string, sendReasoning: boolean): Promise<ProviderRoundResult> => {
      const body: Record<string, unknown> = {
        model: m,
        messages,
        max_tokens: MAX_TOKENS,
        stream: true,
      };
      // Dynamic router models (openrouter/free) accept no reasoning field;
      // only concrete model ids get the effort override.
      if (sendReasoning) body.reasoning = { effort: REASONING_EFFORT };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...HTTP_HEADERS_BASE,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderHttpError(
          `OpenRouter ${res.status} (${m}): ${text.slice(0, 240) || res.statusText}`,
          res.status,
          'openrouter',
        );
      }
      if (!res.body) throw new Error('OpenRouter returned no body');

      return parseOpenAIStream(res.body, onChunk, signal, onReasoning);
    };

    try {
      return await attempt(model, true);
    } catch (err) {
      // Retry once on the openrouter/free dynamic router for failures a
      // different free model can fix (rate limits, 5xx, deprecated model id).
      if (!canFallback(err) || signal.aborted) throw err;
      console.warn(`[openrouter] ${model} failed (${err.status}); retrying via ${FREE_ROUTER_MODEL}`);
      return attempt(FREE_ROUTER_MODEL, false);
    }
  },
};
