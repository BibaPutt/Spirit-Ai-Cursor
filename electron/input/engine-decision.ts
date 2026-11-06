// Pure input-engine routing decisions — no Electron imports, so these unit-test
// in plain Node (vitest/jsdom). The engine adapter (engine.ts) is thin glue
// that calls these.

import type { ToolContent } from './cua-driver-client';

export type EngineKind = 'native' | 'cua-driver';

export interface DriverProbe {
  disabled: boolean;
  binaryFound: boolean;
  handshakeOk: boolean;
}

export function pickEngine(probe: DriverProbe): EngineKind {
  if (probe.disabled || !probe.binaryFound || !probe.handshakeOk) return 'native';
  return 'cua-driver';
}

export type DriverResult = {
  isError?: boolean;
  content?: ToolContent;
  structuredContent?: {
    error?: string;
    kind?: string;
    // CUA action verdict (Hermes/CUA ladder): outcome of one delivered action.
    effect?: string;
    escalation?: { recommended?: string; reason?: string } | string | null;
    code?: string;
    verified?: boolean;
  } | null;
};

// Concatenate the human-readable text the driver returned (content[].text +
// structuredContent.error) so result-analysis regexes have one string to match.
export function resultText(result: DriverResult): string {
  const parts: string[] = [];
  for (const entry of result?.content ?? []) {
    if (typeof entry.text === 'string' && entry.text) parts.push(entry.text);
  }
  const error = result?.structuredContent?.error;
  if (typeof error === 'string' && error) parts.push(error);
  return parts.join(' ');
}

// Structured CUA verdict (Hermes/CUA ladder). The driver reports each action
// as {effect: confirmed|unverifiable|suspected_noop, escalation, code,
// verified}. confirmed = done, never duplicate. unverifiable = recapture
// before any retry. suspected_noop = try pixel fallback, then foreground.
export type VerdictEffect = 'confirmed' | 'unverifiable' | 'suspected_noop' | 'unknown';

export interface DriverVerdict {
  effect: VerdictEffect;
  // Where the driver suggests going next: 'px' | 'foreground' | 'page' | null.
  escalation: string | null;
  escalationReason: string | null;
  // Machine code: stale | background_unavailable | foreground_unsupported | ...
  code: string | null;
  verified: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

export function parseVerdict(result: DriverResult): DriverVerdict {
  const sc = asRecord(result?.structuredContent) ?? {};
  const rawEffect = typeof sc.effect === 'string' ? sc.effect : '';
  const effect: VerdictEffect =
    rawEffect === 'confirmed' || rawEffect === 'unverifiable' || rawEffect === 'suspected_noop'
      ? rawEffect
      : 'unknown';
  const esc = sc.escalation;
  const escRecord = asRecord(esc);
  const escalation =
    typeof esc === 'string'
      ? esc
      : typeof escRecord?.recommended === 'string'
        ? (escRecord.recommended as string)
        : null;
  const escalationReason =
    escRecord && typeof escRecord.reason === 'string' ? (escRecord.reason as string) : null;
  const code = typeof sc.code === 'string' && sc.code ? sc.code : null;
  return { effect, escalation, escalationReason, code, verified: sc.verified === true };
}
// The driver's background (no-focus-steal) delivery reports an explicit
// `background_unavailable` for targets that silently drop posted input — never
// a generic error. This is our signal to escalate just that action to the
// foreground (brief SetForegroundWindow swap + SendInput) once.
export function isBackgroundUnavailable(result: DriverResult): boolean {
  const kind = result?.structuredContent?.kind ?? '';
  return /background_unavailable/.test(resultText(result)) || /background_unavailable/.test(kind);
}

// True when the driver explicitly recommends a foreground retry — either the
// legacy `background_unavailable` signal or a structured verdict with
// escalation.recommended = 'foreground'. Single escalation only (see below).
export function wantsForegroundRetry(result: DriverResult): boolean {
  if (isBackgroundUnavailable(result)) return true;
  const verdict = parseVerdict(result);
  if (verdict.code === 'background_unavailable') return true;
  return verdict.escalation === 'foreground';
}

// Decide retry for one click/type action under desktop scope. Returns the
// delivery mode to retry with, or null to stop retrying. We only escalate once
// per action and never retry a foreground escalation that also failed.
export function nextDeliveryMode(
  attempt: number,
  result: DriverResult,
): 'background' | 'foreground' | null {
  if (attempt >= 1) return null;
  if (wantsForegroundRetry(result)) return 'foreground';
  return null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Small plain scrolls are never declined: same exemption as approval.ts.
// Kept local (no Electron imports) so this module stays unit-testable.
export const SMALL_SCROLL_DELTA_MAX = 5;

export function isNeverDeclineScroll(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName !== 'scroll') return false;
  if (!Object.keys(args ?? {}).every((k) => k === 'delta')) return false;
  const d = Number((args as Record<string, unknown>).delta);
  return Number.isFinite(d) && d !== 0 && Math.abs(d) <= SMALL_SCROLL_DELTA_MAX;
}

// Extract the cursor point from a get_cursor_position tool result. The driver
// may surface x/y at the top level of the result or inside structuredContent.
export function cursorFromResult(result: DriverResult): { x: number; y: number } | null {
  const top = (result ?? {}) as Record<string, unknown>;
  const sc = top.structuredContent as Record<string, unknown> | null | undefined;
  const x = finiteNumber(top.x) ?? finiteNumber(sc?.x);
  const y = finiteNumber(top.y) ?? finiteNumber(sc?.y);
  if (x === null || y === null) return null;
  return { x, y };
}