// Secret redaction before any model round-trip — the Spirit port of GenOffice's
// `sanitizeAgentPayload`. API keys, URL `user:pass@` credentials and password
// assignments pasted into the box (or carried in pasted session history) must
// never reach a remote model verbatim, even when the user meant to share them.
//
// Pure (no Electron, no provider) so vitest can drive it directly.

import type { Message } from './prompt';

export const REDACTED = '***[redacted]***';

// Long secret-looking tokens: common API-key prefixes plus JWT/bearer-shaped
// strings. Deliberately scoped so normal prose, URLs and version numbers are
// never touched.
const API_KEY_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|Bearer\s+[A-Za-z0-9._-]{16,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,})/gi;

// user:pass@ inside a URL — replace the password, keep the host visible.
const URL_CREDENTIALS_RE = /(\/\/)[^/@:\s]+:[^/@\s]+@/g;

// `password=` / `password:` followed by a value.
const PASSWORD_ASSIGN_RE = /\b(password|passwd|pwd|secret)\b\s*[=:]\s*["']?[^"'\s,;]+/gi;

export function sanitizeSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(API_KEY_RE, REDACTED)
    .replace(URL_CREDENTIALS_RE, '$1***@')
    .replace(PASSWORD_ASSIGN_RE, '$1=***');
}

// Sanitize a full message payload the model is about to receive. Keeps every
// message's shape (string / image parts / tool_calls) intact — only user-typed
// text content is scrubbed. Used on a COPY of the conversation so the stored
// history the user sees is never altered.
//
// Identity-preserving: when no payload carried a secret, the SAME array
// instance is returned (nothing was scrubbed, so nothing needs copying). When
// at least one part was redacted, a new array is returned and only the stored
// history stays untouched.
export function sanitizeMessagesPayload(messages: Message[]): Message[] {
  let changed = false;
  const out = messages.map((m) => {
    const s = sanitizeMessage(m);
    if (s !== m) changed = true;
    return s;
  });
  return changed ? out : messages;
}

function sanitizeMessage(m: Message): Message {
  if (m.role === 'assistant') {
    if (!m.tool_calls || m.tool_calls.length === 0) {
      if (typeof m.content !== 'string') return m;
      const content = sanitizeSecrets(m.content);
      return content === m.content ? m : { role: 'assistant', content };
    }
    let dirty = false;
    const tool_calls = m.tool_calls.map((tc) => {
      const args = sanitizeSecrets(tc.function.arguments);
      if (args === tc.function.arguments) return tc;
      dirty = true;
      return {
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: args },
      };
    });
    const content = typeof m.content === 'string' ? sanitizeSecrets(m.content) : m.content;
    if (!dirty && content === m.content) return m;
    const next: Message = { role: 'assistant', content };
    if (tool_calls.length > 0) next.tool_calls = tool_calls;
    return next;
  }
  if (m.role === 'tool') {
    const content = sanitizeSecrets(m.content);
    return content === m.content ? m : { role: 'tool', tool_call_id: m.tool_call_id, content };
  }
  if (typeof m.content === 'string') {
    const content = sanitizeSecrets(m.content);
    return content === m.content ? m : { role: m.role, content };
  }
  let dirty = false;
  const content = m.content.map((p) => {
    if (p.type === 'text') {
      const text = sanitizeSecrets(p.text);
      if (text === p.text) return p;
      dirty = true;
      return { ...p, text };
    }
    return p;
  });
  return dirty ? { role: m.role, content } : m;
}