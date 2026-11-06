// Byte-budget history compaction — the Spirit port of GenOffice's
// `maybeCompact` / `mechanicalDigest` in agent-core. Where Spirit's existing
// `truncateForBudget*` DROPS whole old turns, this keeps a compacted summary of
// them in the conversation so context is preserved instead of deleted.
//
// Strategy (alternation-safe, deterministic, no extra LLM call):
//   1. If the message list fits the token budget → unchanged.
//   2. Otherwise fold the OLD turns (everything before the trailing tail that
//      holds the current query) into a single mechanical digest — the compact,
//      pure excerpt Spirit already builds via `summarizeSessionContext` — and
//      re-insert it as one synthetic assistant message. Message ORDER and role
//      alternation stay valid (assistant text turn, then the tail's user turn).
//   3. If not even the digest fits, fall back to the existing drop-middle
//      behaviour so behavior degrades exactly as before this module existed.
//
// Pure module (no Electron, no provider) so vitest can drive it directly.

import { estimateTokens, truncateForBudgetKeepLast } from '../memory/sessions';
import { summarizeSessionContext } from './chips-parse';
import type { Message } from './prompt';

export const COMPACT_MARKER = '[Previous conversation — compacted overview]';

export type CompactResult = {
  messages: Message[];
  // True when the history was actually compacted (vs. already within budget).
  compacted: boolean;
};

// Fold everything before `tail` messages into a compacted summary while the
// trailing messages (the current query) are kept verbatim.
export function compactForBudgetKeepLast(
  messages: Message[],
  maxTokens: number,
  tail = 1,
): CompactResult {
  if (messages.length <= 3) return { messages, compacted: false };
  if (messages.reduce((s, m) => s + estimateTokens(m), 0) <= maxTokens) {
    return { messages, compacted: false };
  }

  const splitAt = messages.length - tail;
  // Need at least [system, first user, one more] to fold something meaningful.
  if (splitAt <= 2) {
    return { messages: truncateForBudgetKeepLast(messages, maxTokens, tail), compacted: true };
  }

  const head = messages.slice(0, splitAt);
  const kept = messages.slice(splitAt);
  const digest = summarizeSessionContext(head);
  if (!digest) {
    return { messages: truncateForBudgetKeepLast(messages, maxTokens, tail), compacted: true };
  }

  // The digest becomes an assistant text message so alternation stays intact:
  // the folded head (which ended on the head's last message) is replaced by
  // this assistant turn, and the tail's first message is the current query.
  const summaryMsg: Message = {
    role: 'assistant',
    content: `${COMPACT_MARKER}\n${digest}`,
  };
  const candidate = [messages[0], messages[1], summaryMsg, ...kept];
  if (candidate.reduce((s, m) => s + estimateTokens(m), 0) <= maxTokens) {
    return { messages: candidate, compacted: true };
  }
  // Digest still too big (pathological) — fall back to the old drop-middle.
  return { messages: truncateForBudgetKeepLast(messages, maxTokens, tail), compacted: true };
}