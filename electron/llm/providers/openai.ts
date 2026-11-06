import { MAX_TOKENS, REASONING_EFFORT } from '../models';
import {
  HTTP_HEADERS_BASE,
  ProviderHttpError,
  type ProviderClient,
} from './types';
import { parseOpenAIStream } from './openai-stream';

// OpenAI direct. Same wire format as OpenRouter but stricter on extra params
// (no `reasoning` field unless using reasoning-capable models).

const MODELS = {
  fast: 'gpt-5-mini',
  capable: 'gpt-5',
} as const;

const REASONING_MODELS = new Set(['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o1', 'o3']);

export const openaiProvider: ProviderClient = {
  id: 'openai',
  displayName: 'OpenAI',

  pickModel(req) {
    return req.tier === 'capable' ? MODELS.capable : MODELS.fast;
  },

  supports(cap, req) {
    if (cap === 'web') return false; // No native web search in chat completions.
    if (cap === 'vision') return true;
    if (cap === 'tools') return true;
    void req;
    return false;
  },

  async runRound(model, messages, apiKey, tools, signal, onChunk, onReasoning) {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: MAX_TOKENS,
      stream: true,
    };
    // OpenAI reasoning models accept `reasoning_effort` instead of `reasoning`.
    const baseModel = model.split(':')[0];
    if (REASONING_MODELS.has(baseModel) || baseModel.startsWith('gpt-5') || baseModel.startsWith('o')) {
      body.reasoning_effort = REASONING_EFFORT;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
        `OpenAI ${res.status}: ${text.slice(0, 240) || res.statusText}`,
        res.status,
        'openai',
      );
    }
    if (!res.body) throw new Error('OpenAI returned no body');
    return parseOpenAIStream(res.body, onChunk, signal, onReasoning);
  },
};
