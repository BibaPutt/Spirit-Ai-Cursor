import { MAX_TOKENS } from '../models';
import type { ContentBlock, Message } from '../prompt';
import type { ToolDeclaration } from '../tools';
import {
  HTTP_HEADERS_BASE,
  ProviderHttpError,
  type ProviderClient,
  type ProviderRoundResult,
} from './types';

// Google Generative Language API direct. Distinct format:
//  - contents[] with { role, parts[] }
//  - systemInstruction at top level
//  - tools is array of { functionDeclarations: [...] }
//  - Streaming via :streamGenerateContent?alt=sse

const MODELS = {
  fast: 'gemini-2.5-flash',
  capable: 'gemini-2.5-pro',
} as const;

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

function translate(messages: Message[]): {
  systemInstruction: { parts: { text: string }[] } | undefined;
  contents: GeminiContent[];
  toolNameById: Map<string, string>;
} {
  let systemText = '';
  const contents: GeminiContent[] = [];
  const toolNameById = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (typeof msg.content === 'string' ? msg.content : '') + '\n';
      continue;
    }
    if (msg.role === 'user') {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else {
        for (const p of msg.content as ContentBlock[]) {
          if (p.type === 'text') parts.push({ text: p.text });
          else if (p.type === 'image_url') {
            const url = p.image_url.url;
            const match = url.match(/^data:(image\/[\w+.-]+);base64,(.*)$/);
            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
      }
      contents.push({ role: 'user', parts });
      continue;
    }
    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        parts.push({ text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }
          toolNameById.set(tc.id, tc.function.name);
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    if (msg.role === 'tool') {
      const name = toolNameById.get(msg.tool_call_id) ?? msg.tool_call_id;
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { content: msg.content } } }],
      });
    }
  }

  return {
    systemInstruction: systemText.trim() ? { parts: [{ text: systemText.trim() }] } : undefined,
    contents,
    toolNameById,
  };
}

function translateTools(tools: ToolDeclaration[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

async function parseGeminiStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<ProviderRoundResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentText = '';
  let finishReason: string | null = null;
  const toolCalls: ProviderRoundResult['toolCalls'] = [];

  // Cancel the reader on abort so we stop draining the server stream the
  // moment the user hits ESC. Without this, fetch is aborted but the read
  // loop keeps consuming buffered bytes.
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
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        let payload: any;
        try {
          payload = JSON.parse(dataStr);
        } catch {
          continue;
        }
        const candidate = payload?.candidates?.[0];
        if (!candidate) continue;
        if (candidate.finishReason) finishReason = candidate.finishReason;

        const parts = candidate.content?.parts;
        if (!Array.isArray(parts)) continue;

        for (const part of parts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            contentText += part.text;
            onChunk(part.text);
          } else if (part.functionCall) {
            const argsObj = part.functionCall.args;
            const hasProperArgs = typeof argsObj === 'object' && argsObj !== null;
            toolCalls.push({
              id: `call_${toolCalls.length}_${Date.now()}`,
              name: part.functionCall.name,
              args: (hasProperArgs ? argsObj : {}) as Record<string, unknown>,
              inputError: !hasProperArgs,
              truncated: finishReason === 'MAX_TOKENS',
            });
          }
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

  return { contentText, toolCalls, finishReason };
}

export const geminiProvider: ProviderClient = {
  id: 'gemini',
  displayName: 'Google Gemini',

  pickModel(req) {
    return req.tier === 'capable' ? MODELS.capable : MODELS.fast;
  },

  supports(cap) {
    // Vision, tools, and we'll add Google Search grounding as a meta-tool.
    return cap === 'vision' || cap === 'tools' || cap === 'web';
  },

  async runRound(model, messages, apiKey, tools, signal, onChunk) {
    const { systemInstruction, contents } = translate(messages);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (tools && tools.length > 0) body.tools = translateTools(tools);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:streamGenerateContent?alt=sse`;

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        ...HTTP_HEADERS_BASE,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderHttpError(
        `Gemini ${res.status}: ${text.slice(0, 240) || res.statusText}`,
        res.status,
        'gemini',
      );
    }
    if (!res.body) throw new Error('Gemini returned no body');
    return parseGeminiStream(res.body, onChunk, signal);
  },
};
