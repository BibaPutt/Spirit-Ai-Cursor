import type { Message } from '../prompt';
import type { ToolDeclaration } from '../tools';

export type ProviderId = 'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'localai' | 'opencode';

export type ModelCapability = 'vision' | 'tools' | 'web';

export type ProviderConfig = {
  id: ProviderId;
  apiKey: string;
  enabled: boolean;
};

export type StreamHandlers = {
  onChunk: (text: string) => void;
  onToolStart: (id: string, label: string, name: string, args: unknown) => void;
  onToolEnd: (id: string, name: string, ok: boolean, summary: string) => void;
  // Live chain-of-thought (reasoning_content) deltas as a reasoning model
  // streams them. Optional — providers without exposed reasoning never call it.
  onReasoning?: (delta: string) => void;
  onDone: () => void;
  // Typed error surface: the renderer can show a tailored message per code
  // (network / overloaded / credits / timeout / auth / unknown) instead of a
  // raw provider dump.
  onError: (msg: string, code?: unknown) => void;
  // A run that failed AFTER producing text. Unlike onError this keeps the
  // partial answer: the caller commits it to history and offers Continue.
  // Omitted handlers fall back to onError (nothing partial to preserve).
  onInterrupted?: (msg: string, code?: unknown, partialText?: string) => void;
  // Authoritative cleaned final answer at the end of a run. The caller
  // replaces the streamed response content with this text (streamed chunks
  // may include tool-call junk the router stripped out).
  onFinalAnswer: (text: string) => void | Promise<void>;
};

export type RequestRequirements = {
  // Whether the user wants web-grounded answer.
  web: boolean;
  // True if the request has an image (vision needed).
  vision: boolean;
  // True if tool use is desired for this turn (default true).
  allowTools: boolean;
  // 'fast' for quick Q&A, 'capable' for /summary, /brief etc.
  tier: 'fast' | 'capable';
};

export type ProviderToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  // True when the provider could not parse the model's args (malformed JSON)
  // — the router feeds a targeted "fix your JSON" error back instead of
  // executing garbage.
  inputError?: boolean;
  // True when the generation was cut off while still emitting the call — the
  // args are incomplete and must be re-requested, not executed.
  truncated?: boolean;
};

export type ProviderRoundResult = {
  contentText: string;
  toolCalls: ProviderToolCall[];
  finishReason: string | null;
  // Chain-of-thought the model streamed (reasoning_content). Not surfaced to
  // the UI, but logged for diagnosis — a model that keeps looping on the same
  // tool almost always reveals why in its reasoning.
  reasoningText?: string;
};

export type AgentContext = {
  latestAssistantText: string;
  originalPrompt: string;
  // The user's original request for the whole session (from the first user
  // message), carried across resume turns so follow-ups like "ok" or "yes"
  // still target the ORIGINAL goal when picking click targets.
  sessionGoal?: string;
  abort: AbortSignal;
  requireToolApproval: (
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;
};

export interface ProviderClient {
  id: ProviderId;
  displayName: string;
  // Pick the best model for the request. Returns the provider-specific
  // model identifier the provider's runRound will use.
  pickModel(req: RequestRequirements): string;
  // Whether this provider+model can handle the given capability for this
  // request. The router uses this to gate which tools are advertised
  // (e.g. drop tools entirely if the chosen model has no tool support).
  supports(capability: ModelCapability, req: RequestRequirements): boolean;
  // Run one streaming round against the provider. Returns the model's
  // content + any tool calls it requested. The router handles the
  // multi-turn agentic loop on top of this.
  runRound(
    model: string,
    messages: Message[],
    apiKey: string,
    tools: ToolDeclaration[] | undefined,
    signal: AbortSignal,
    onChunk: (text: string) => void,
    onReasoning?: (delta: string) => void,
  ): Promise<ProviderRoundResult>;
}

export const HTTP_HEADERS_BASE = {
  'X-Title': 'Spirit',
  'User-Agent': 'Spirit/1.1.0',
} as const;

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public provider: ProviderId,
  ) {
    super(message);
  }
}

export function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}
