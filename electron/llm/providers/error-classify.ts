// Typed stream-error classification — the Spirit port of GenOffice's
// `isAiNetworkError` / `isAiOverloadedError` / credits detection in ai-provider.
//
// Turns a raw provider exception into { code, message } so the IPC layer can
// send a typed errorCode ('network' | 'overloaded' | 'credits' | 'timeout' |
// 'auth' | 'thinking-limit' | 'unknown') to the renderer and tailor the
// message a human reads. Pure module (no Electron) so vitest can drive it.

import { ProviderHttpError } from './types';

export type ErrorCode =
  | 'network'
  | 'overloaded'
  | 'credits'
  | 'timeout'
  | 'auth'
  | 'thinking-limit'
  | 'unknown';

export type ClassifiedError = { code: ErrorCode; message: string };

// Soften an HTTP status into a code that explains WHY (not just "it failed").
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 409 || status === 451) return 'credits';
  if (status === 429) return 'overloaded';
  if (status === 408 || status >= 500) return 'overloaded';
  return 'unknown';
}

const CREDITS_HINTS =
  /\b(insufficient|out of|exhausted|no (?:more|available))?\s*(credits?|quota|balance|billing|billing_required)\b/i;

// Free-tier exhaustion arrives as HTTP 429, which would otherwise be softened
// into "busy, try again in a moment" — wrong advice, because the quota does
// not recover on a retry. Detect the wording and report it as a credits issue
// so the user is told to add a key / switch provider.
const FREE_TIER_HINTS =
  /free tier quota|FreeUsageLimitError|free usage limit|subscribe to OpenCode Go/i;

const NETWORK_HINTS =
  /(?:failed to fetch|fetch failed|networkerror|network error|enetunreach|enotfound|econnrefused|econnreset|etimedout|socket hang up|tunnel connection|endpoint rejected|certificate|unable to connect|could not connect|could not reach|ECONN|ERR_NAME_NOT_RESOLVED|operation aborted|timeout of \d+ms)/i;

// Token-budget overflow: the model ran out of output/completion tokens
// (commonly because its thinking phase ate the whole budget) and produced no
// usable content. Distinct from overload (retry as-is) and timeout; the right
// recovery is a retry with a raised budget and degraded reasoning, not a hard
// "try again later" — providers word this many ways.
const TOKEN_BUDGET_HINTS =
  /(?:max(?:imum)?|requested|allowed|exceeded|reached|limit|budget).{0,45}(?:token|context|output|length|completion)s?\b|(?:token|context|output|length|completion)s?[^.!?\n]{0,40}(?:limit|budget|exceeded?|reached?)|context[^.!?\n]{0,30}(?:length|window)[^.!?\n]{0,30}(?:exceed|limit|reach|long|big)|too (?:many|much) (?:token|input|output|completion)s?|(?:request|prompt|input|message)s?[^.!?\n]{0,25}too long|produced invalid content|empty (?:response|completion)|(?:thinking|chain[ -]of[ -]thought)[^.!?\n]{0,60}(?:limit|token|budget|exceed|reach|cut)/i;

// Needs at least this much of a body to read like a human message before we
// graft a friendly prefix onto it (avoids doubling up long JSON dumps).
const FRIENDLY_PREFIX_MAX = 200;

export function classifyError(
  err: unknown,
  providerDisplay = 'the provider',
): ClassifiedError {
  const rawMessage = err instanceof Error ? err.message : String(err ?? 'Unknown error');

  if (err instanceof ProviderHttpError) {
    const code = codeForStatus(err.status);
    let message = rawMessage || `Provider ${err.status}.`;
    if (code === 'auth') {
      // Keyless local servers (Local AI / opencode) have no key —
      // a 401/403 means the upstream rejected this model or request shape.
      // Never tell the user to check an API key that doesn't exist.
      if (err.provider === 'localai' || err.provider === 'opencode') {
        message =
          `${providerDisplay} rejected the request (${err.status}) — this server uses no key. ` +
          'Try another model in /settings.';
      } else {
        message = `Auth failed for ${providerDisplay} (${err.status}). Check the API key in /settings.`;
      }
    } else if (code === 'credits') {
      message =
        `${providerDisplay} reported insufficient credits or quota (${err.status}). ` +
        'Top up or switch provider in /settings.';
    } else if (FREE_TIER_HINTS.test(rawMessage)) {
      return { code: 'credits', message: rawMessage };
    } else if (code === 'overloaded' && rawMessage.length <= FRIENDLY_PREFIX_MAX) {
      message = `${providerDisplay} is busy or overloaded (${err.status}). Try again in a moment.`;
    }
    return { code, message };
  }

  if (/timeout|timed out/i.test(rawMessage)) {
    return { code: 'timeout', message: `Request timed out (${providerDisplay} did not reply). Try again, or check /settings.` };
  }
  if (TOKEN_BUDGET_HINTS.test(rawMessage)) {
    return {
      code: 'thinking-limit',
      message:
        `${providerDisplay} hit its token budget while composing (often the thinking phase runs long). ` +
        "Retrying with a bigger budget and lighter thinking.",
    };
  }
  if (CREDITS_HINTS.test(rawMessage)) {
    return { code: 'credits', message: `${providerDisplay} reported insufficient credits or quota. Top up or switch provider in /settings.` };
  }
  if (NETWORK_HINTS.test(rawMessage)) {
    return {
      code: 'network',
      message: `Network error reaching ${providerDisplay}. Check your connection and try again.`,
    };
  }
  return { code: 'unknown', message: rawMessage };
}