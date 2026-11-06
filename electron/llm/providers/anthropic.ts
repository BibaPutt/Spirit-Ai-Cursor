import { MAX_TOKENS } from '../models';
import type { ContentBlock, Message } from '../prompt';
import type { ToolDeclaration } from '../tools';
import {
  HTTP_HEADERS_BASE,
  ProviderHttpError,
  type ProviderClient,
  type ProviderRoundResult,
} from './types';

// Anthropic Messages API. Different format from OpenAI:
//  - system is top-level
//  - assistant/tool roles structured as content blocks
//  - streaming uses event-based SSE (message_start, content_block_start, etc)

const MODELS = {
  fast: 'claude-haiku-4-5',
  capable: 'claude-sonnet-4-6',
} as const;

const ANTHROPIC_VERSION = '2023-06-01';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function translateMessages(messages: Message[]): { system: string; messages: AnthropicMessage[] } {
  let system = '';
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (typeof msg.content === 'string' ? msg.content : '') + '\n';
      continue;
    }
    if (msg.role === 'user') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.content === 'string') {
        blocks.push({ type: 'text', text: msg.content });
      } else {
        for (const part of msg.content as ContentBlock[]) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const url = part.image_url.url;
            const match = url.match(/^data:(image\/[\w+.-]+);base64,(.*)$/);
            if (match) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              });
            }
          }
        }
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        blocks.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = { _raw: tc.function.arguments };
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
      });
    }
  }

  return { system: system.trim(), messages: out };
}

function translateTools(tools: ToolDeclaration[]) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<ProviderRoundResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentText = '';
  let finishReason: string | null = null;
  const toolBlocks: Map<number, { id: string; name: string; argsText: string }> = new Map();

  // Cancel the reader when the caller aborts so we stop draining bytes
  // immediately instead of waiting for the connection to time out.
  const onAbort = () => {
    try {
      void reader.cancel('aborted by user');
    } catch {
      /* reader may already be closed */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        const lines = event.split('\n');
        const dataLine = lines.find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const dataStr = dataLine.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        let payload: any;
        try {
          payload = JSON.parse(dataStr);
        } catch {
          continue;
        }
        const type = payload.type;

        if (type === 'content_block_start') {
          const idx: number = payload.index ?? 0;
          const cb = payload.content_block;
          if (cb?.type === 'tool_use') {
            toolBlocks.set(idx, { id: cb.id, name: cb.name, argsText: '' });
          }
          continue;
        }
        if (type === 'content_block_delta') {
          const idx: number = payload.index ?? 0;
          const d = payload.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
            contentText += d.text;
            onChunk(d.text);
          } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const acc = toolBlocks.get(idx);
            if (acc) acc.argsText += d.partial_json;
          }
          continue;
        }
        if (type === 'message_delta') {
          if (payload.delta?.stop_reason) finishReason = payload.delta.stop_reason;
        }
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  const toolCalls: ProviderRoundResult['toolCalls'] = [];
  for (const [, acc] of toolBlocks) {
    let args: Record<string, unknown> = {};
    let inputError = false;
    if (acc.argsText.trim()) {
      try {
        args = JSON.parse(acc.argsText);
      } catch {
        inputError = true;
        args = { _raw: acc.argsText };
      }
    }
    toolCalls.push({
      id: acc.id,
      name: acc.name,
      args,
      inputError,
      truncated: finishReason === 'max_tokens' || finishReason === 'length',
    });
  }

  if (toolCalls.length > 0 && finishReason !== 'tool_use') finishReason = 'tool_use';
  return { contentText, toolCalls, finishReason };
}

export const anthropicProvider: ProviderClient = {
  id: 'anthropic',
  displayName: 'Anthropic',

  pickModel(req) {
    return req.tier === 'capable' ? MODELS.capable : MODELS.fast;
  },

  supports(cap) {
    // Vision + tools yes, web no (would need explicit web_search tool, deferred).
    return cap === 'vision' || cap === 'tools';
  },

  async runRound(model, messages, apiKey, tools, signal, onChunk) {
    const { system, messages: anthropicMessages } = translateMessages(messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: anthropicMessages,
    };
    if (system) body.system = system;
    if (tools && tools.length > 0) body.tools = translateTools(tools);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
        ...HTTP_HEADERS_BASE,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderHttpError(
        `Anthropic ${res.status}: ${text.slice(0, 240) || res.statusText}`,
        res.status,
        'anthropic',
      );
    }
    if (!res.body) throw new Error('Anthropic returned no body');
    return parseAnthropicStream(res.body, onChunk, signal);
  },
};
