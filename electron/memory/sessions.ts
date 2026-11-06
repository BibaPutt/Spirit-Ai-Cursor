import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { stripVolatileContextBlocks, type ContentBlock, type Message } from '../llm/prompt';
import { getSettings, getWorkspaceFolder } from '../store/settings';
import { renderHtmlDocument } from '../save/template';
import { resolveAutoContextBudget } from '../llm/models';
import type { SessionSummary } from '../types';

// Sessions are stored under <workspace>/sessions/ as JSON + an optional HTML
// transcript. Both are auto-generated on session end if memorySaveEnabled.

type SessionTurn = {
  user: string;
  assistant: string;
};

export type ActiveSession = {
  id: string;
  startedAt: number;
  imageB64: string;
  // OCR text of the trigger screenshot, attached to the first-turn prompt so
  // text-only models (free tiers) can read what's on screen even though they
  // can't see the image. Populated at capture time; '' when OCR is unavailable
  // or no screenshot was captured.
  screenshotOcr: string;
  clipboard: string;
  // Text the user had selected on screen when the box opened (captured via
  // UIA or the Ctrl+C fallback). Attached to the first-turn prompt so the
  // LLM sees what the user highlighted, same as Python spirit's "The user
  // also selected this text on their screen".
  selection: string;
  // Full message history including system, alternating user/assistant, and tool messages.
  messages: Message[];
  firstPrompt: string;
  turnCount: number;
  templateId: string | null;
  web: boolean;
  // Set to true after a drag-rectangle selection capture. The next
  // submit then sends the screenshot WITHOUT clipboard text, so the
  // user's deliberate visual scope isn't polluted by whatever text
  // they happened to have copied. Cleared after the next submit.
  suppressClipboardOnce?: boolean;
};

function sessionsDir(): string {
  return join(getWorkspaceFolder(), 'sessions');
}

export async function ensureSessionsDir(): Promise<string> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function newSessionId(): string {
  // Sortable timestamp + short random suffix.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

function safeName(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return cleaned || fallback;
}

// Approximate token counting: 4 chars ≈ 1 token. Image blocks counted as a
// fixed 1500 tokens (vision inputs are encoded differently per provider but
// this is close enough for budgeting).
const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_COST = 1500;

export function estimateTokens(message: Message): number {
  if (message.role === 'system' || message.role === 'user') {
    if (typeof message.content === 'string') {
      return Math.ceil(message.content.length / CHARS_PER_TOKEN);
    }
    let total = 0;
    for (const part of message.content) {
      if (part.type === 'text') total += Math.ceil(part.text.length / CHARS_PER_TOKEN);
      else if (part.type === 'image_url') total += IMAGE_TOKEN_COST;
    }
    return total;
  }
  if (message.role === 'assistant') {
    const text = typeof message.content === 'string' ? message.content : '';
    let total = Math.ceil(text.length / CHARS_PER_TOKEN);
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        total += Math.ceil((tc.function.name.length + tc.function.arguments.length) / CHARS_PER_TOKEN);
      }
    }
    return total;
  }
  // tool messages
  return Math.ceil(message.content.length / CHARS_PER_TOKEN);
}

// Screen observations (a numbered element list / a screenshot) are only true at
// the moment they were taken. A screen-changing action that runs afterwards
// supersedes them, so keeping the full result in context just burns tokens and
// — worse — lets a weak model act on UI that no longer exists. This masks the
// consumed observations with a short pointer (JetBrains Junie's "observation
// masking": zero-compute, no summarization LLM call). Clipboard/document tools
// are NOT screen observations and are never touched.
const SCREEN_CHANGING_TOOLS = new Set([
  'click', 'ui_click', 'double_click', 'drag',
  'type_text', 'press_key', 'scroll',
  'open_url', 'launch_app', 'system_action', 'run_command',
]);
const SCREEN_OBSERVATION_TOOLS = new Set(['ui_read', 'see_screen']);
const STALE_OBSERVATION_MASK =
  '[The screen changed after this observation — this result is superseded. ' +
  'Rely on the screen state captured after the change, not this.]';

export function maskStaleObservations(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  // Map each tool_call_id to its tool name so tool results can be classified.
  const callName = new Map<string, string>();
  const toolIndexes: Array<{ index: number; callId: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) callName.set(tc.id, tc.function.name);
    } else if (m.role === 'tool') {
      toolIndexes.push({ index: i, callId: m.tool_call_id });
    }
  }
  if (toolIndexes.length === 0) return messages;

  // Did a screen-changing action run AFTER this message index? If so, every
  // screen observation before it is stale.
  const screenChangedAfter = (fromIndex: number): boolean => {
    for (let j = fromIndex + 1; j < messages.length; j++) {
      const m = messages[j];
      if (
        m.role === 'assistant' &&
        m.tool_calls &&
        m.tool_calls.some((tc) => SCREEN_CHANGING_TOOLS.has(tc.function.name))
      ) {
        return true;
      }
    }
    return false;
  };

  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== 'tool') return m;
    const name = callName.get(m.tool_call_id);
    if (!name || !SCREEN_OBSERVATION_TOOLS.has(name)) return m;
    if (!screenChangedAfter(i)) return m;
    changed = true;
    return { ...m, content: STALE_OBSERVATION_MASK };
  });
  return changed ? out : messages;
}

// Topic-pivot de-anchoring: when the current follow-up question changed topic
// (classifyTopicPivot === 'pivot'), the FIRST user message's heavy context —
// original OCR, clipboard, app context — is dead weight that drags small
// models back to the session's opening topic (observed: "what is a widget"
// answered with cow facts from turn 1's screen). Mirror of maskStaleObservations:
// don't delete the message, just replace the bloated text with a compact stub
// that keeps the ORIGINAL question so the audit trail — and "back to the cows
// again" references — survive. Runs before truncateForBudget, so the freed
// budget stays available for the actual recent turns.
// The original OCR text itself remains stored on the ActiveSession (screenshotOcr)
// for the current screen; only the STALE first-turn readback is dropped.
const TURN_ONE_PIVOT_MASK = (firstPrompt: string) =>
  `[Session opened with: ${firstPrompt}. Earlier screen text omitted — the current question changed topic.]`;

export function maskTurnOneOnPivot(messages: Message[]): Message[] {
  if (messages.length < 2) return messages;
  const first = messages[1];
  if (first.role !== 'user') return messages;

  // The original question is the text BEFORE the first blank line (context
  // blocks — OCR/clipboard/app — are appended after a blank line by buildMessages).
  let text = '';
  if (typeof first.content === 'string') text = first.content;
  else if (Array.isArray(first.content)) {
    text = first.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }
  const firstParagraph = text.split(/\n\s*\n/)[0]?.trim() || '';
  if (!firstParagraph) return messages;

  const stub = TURN_ONE_PIVOT_MASK(firstParagraph.slice(0, 200));

  if (typeof first.content === 'string') {
    // Already text-only (the renderer strips images on follow-ups) — safe to
    // replace wholesale.
    return [
      messages[0],
      { ...first, content: stub },
      ...messages.slice(2),
    ];
  }

  // Keep any non-text parts (image blocks) intact; swap the text out for the stub.
  const nonText = Array.isArray(first.content)
    ? first.content.filter((p) => p.type !== 'text')
    : [];
  const replacement: ContentBlock[] =
    nonText.length > 0
      ? [{ type: 'text', text: stub }, ...nonText]
      : [{ type: 'text', text: stub }];
  return [
    messages[0],
    { ...first, content: replacement },
    ...messages.slice(2),
  ];
}

// Trim the messages array to fit under `maxTokens`. Always preserves:
//   - system message (index 0)
//   - the FIRST user message (it carries the screenshot — recreating it is
//     impossible since the box is in the way of the screen now).
// Drops oldest middle-turn pairs (user + assistant + tool messages) until
// the total fits.
export function truncateForBudget(messages: Message[], maxTokens: number): Message[] {
  if (messages.length <= 2) return messages;

  const total = () => messages.reduce((s, m) => s + estimateTokens(m), 0);
  if (total() <= maxTokens) return messages;

  const sys = messages[0];
  const firstUser = messages[1];
  let middle = messages.slice(2);

  while (middle.length > 0 && estimateTokens(sys) + estimateTokens(firstUser) + middle.reduce((s, m) => s + estimateTokens(m), 0) > maxTokens) {
    // Drop the oldest turn — that means up to and including the next user msg
    // so we never leave a stray assistant or tool message at the head.
    let dropTo = 1;
    while (dropTo < middle.length && middle[dropTo].role !== 'user') dropTo++;
    middle = middle.slice(dropTo);
  }

  return [sys, firstUser, ...middle];
}

// Trim to fit `maxTokens` while ALWAYS preserving the trailing `tail` messages
// (the just-typed user question, possibly with an in-flight assistant reply).
// The RAG memory block is injected into the system message AFTER the first
// truncation pass, so a guard pass after that injection must be allowed to
// drop more history — but never the query the user is waiting on. `tail=0`
// behaves exactly like truncateForBudget.
export function truncateForBudgetKeepLast(
  messages: Message[],
  maxTokens: number,
  tail = 1,
): Message[] {
  if (messages.length <= 2) return messages;
  if (tail >= messages.length - 1) return messages;
  if (messages.reduce((s, m) => s + estimateTokens(m), 0) <= maxTokens) return messages;
  const splitAt = messages.length - tail;
  const head = messages.slice(0, splitAt);
  const kept = messages.slice(splitAt);
  return [...truncateForBudget(head, maxTokens), ...kept];
}

export async function persistSession(active: ActiveSession): Promise<SessionSummary | null> {
  try {
    const dir = await ensureSessionsDir();
    const baseName = `${active.id}-${safeName(active.firstPrompt, 'session')}`;
    const jsonPath = join(dir, `${baseName}.json`);

    // Compose a transcript JSON + a markdown body for the HTML export.
    const turns = collectTurns(active.messages);
    const json = {
      id: active.id,
      startedAt: active.startedAt,
      endedAt: Date.now(),
      firstPrompt: active.firstPrompt,
      turnCount: turns.length,
      web: active.web,
      templateId: active.templateId,
      turns,
    };
    await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf-8');

    let htmlPath: string | null = null;
    if (turns.length > 0) {
      htmlPath = join(dir, `${baseName}.html`);
      const markdown = turnsToMarkdown(active.firstPrompt, turns);
      const html = await renderHtmlDocument({
        prompt: active.firstPrompt,
        markdown,
        web: active.web,
        generatedAt: new Date(active.startedAt),
      });
      await fs.writeFile(htmlPath, html, 'utf-8');
    }

    const workspace = getWorkspaceFolder();
    return {
      id: active.id,
      startedAt: active.startedAt,
      endedAt: json.endedAt,
      firstPrompt: active.firstPrompt,
      turnCount: turns.length,
      jsonRelativePath: relative(workspace, jsonPath),
      htmlRelativePath: htmlPath ? relative(workspace, htmlPath) : null,
    };
  } catch (err) {
    console.error('[sessions] persist failed:', err);
    return null;
  }
}

function collectTurns(messages: Message[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let pendingUser: string | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') pendingUser = msg.content;
      else {
        const textPart = msg.content.find((p) => p.type === 'text');
        pendingUser = textPart && 'text' in textPart ? textPart.text : '';
      }
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (pendingUser !== null) {
        // Transcript privacy: keep the question, drop the volatile context
        // blocks (clipboard/selection/OCR/app) that ride along in the user
        // message for the model's eyes only.
        turns.push({ user: stripVolatileContextBlocks(pendingUser), assistant: text });
        pendingUser = null;
      }
    }
  }
  return turns;
}

function turnsToMarkdown(_firstPrompt: string, turns: SessionTurn[]): string {
  const lines: string[] = [];
  turns.forEach((t, i) => {
    lines.push(`## Turn ${i + 1}`);
    lines.push('');
    lines.push('**You asked:**');
    lines.push('');
    lines.push(`> ${t.user.replace(/\n/g, '\n> ')}`);
    lines.push('');
    lines.push('**Spirit:**');
    lines.push('');
    lines.push(t.assistant);
    lines.push('');
    if (i < turns.length - 1) lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

// Load the most recently saved session and render it as a markdown
// transcript ready to drop into the response area. Used by the
// /lastsession slash command so a user who closed the box by accident
// can quickly re-read what was just there without going through the
// /history → reveal-in-Finder dance.
//
// Returns null when no sessions exist (or session-saving is off).
export async function loadLatestSessionMarkdown(): Promise<string | null> {
  const sessions = await listSessions();
  if (sessions.length === 0) return null;
  // listSessions returns newest-first already (sortable timestamp IDs).
  const latest = sessions[0];
  const abs = resolveSessionRelativePath(latest.jsonRelativePath);
  if (!abs) return null;
  try {
    const raw = await fs.readFile(abs, 'utf-8');
    const parsed = JSON.parse(raw) as {
      firstPrompt?: string;
      startedAt?: number;
      turnCount?: number;
      turns?: SessionTurn[];
    };
    const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
    if (turns.length === 0) return null;
    const lines: string[] = [];
    lines.push(`## Last session — ${parsed.firstPrompt ?? '(no prompt)'}`);
    if (parsed.startedAt) {
      lines.push(`*${new Date(parsed.startedAt).toLocaleString()} · ${turns.length} turn${turns.length === 1 ? '' : 's'}*`);
    }
    lines.push('');
    lines.push(turnsToMarkdown(parsed.firstPrompt ?? '', turns));
    return lines.join('\n');
  } catch (err) {
    console.warn('[sessions] loadLatestSessionMarkdown failed:', err);
    return null;
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  try {
    const workspace = getWorkspaceFolder();
    const dir = sessionsDir();
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const jsons = entries.filter((f) => f.endsWith('.json'));
    const summaries: SessionSummary[] = [];
    for (const name of jsons) {
      try {
        const jsonPath = join(dir, name);
        const raw = await fs.readFile(jsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const htmlPath = jsonPath.replace(/\.json$/, '.html');
        const hasHtml = await fs
          .access(htmlPath)
          .then(() => true)
          .catch(() => false);
        // Migration: if a legacy v1.0.0 session JSON ever stored absolute
        // jsonPath / htmlPath fields inside its body, rewrite the file
        // without those fields. Current writer never emits them, so this is
        // a one-shot belt-and-braces cleanup.
        if ('jsonPath' in parsed || 'htmlPath' in parsed) {
          delete parsed.jsonPath;
          delete parsed.htmlPath;
          await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf-8').catch(() => undefined);
        }
        summaries.push({
          id: String(parsed.id ?? name),
          startedAt: Number(parsed.startedAt ?? 0),
          endedAt: Number(parsed.endedAt ?? 0),
          firstPrompt: String(parsed.firstPrompt ?? ''),
          turnCount: Number(parsed.turnCount ?? 0),
          jsonRelativePath: relative(workspace, jsonPath),
          htmlRelativePath: hasHtml ? relative(workspace, htmlPath) : null,
        });
      } catch {
        /* skip malformed */
      }
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries.slice(0, 50);
  } catch (err) {
    console.error('[sessions] list failed:', err);
    return [];
  }
}

// Resolve a renderer-supplied relative path against the workspace and refuse
// anything that escapes the workspace boundary. Returns the resolved absolute
// path, or null if the input is rejected.
export function resolveSessionRelativePath(rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const workspace = getWorkspaceFolder();
  const resolved = join(workspace, rel);
  const back = relative(workspace, resolved);
  if (back.startsWith('..') || back.startsWith('/') || back.includes('..\\')) return null;
  return resolved;
}

export async function clearAllSessions(): Promise<{ removed: number }> {
  try {
    const dir = sessionsDir();
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of entries) {
      if (name.endsWith('.json') || name.endsWith('.html')) {
        await fs.unlink(join(dir, name)).catch(() => undefined);
        removed++;
      }
    }
    return { removed };
  } catch (err) {
    console.error('[sessions] clear failed:', err);
    return { removed: 0 };
  }
}

export function shouldPersist(): boolean {
  return getSettings().memorySaveEnabled === true;
}

export function getMaxContextTokens(modelId?: string, providerId?: string): number {
  const s = getSettings();
  // Auto (default): budget follows the serving model's real window, not the
  // fixed user number. The manual slider applies only when the user turns
  // Auto off in settings.
  if (s.autoContext !== false) {
    try {
      return resolveAutoContextBudget(modelId ?? '', providerId === 'localai');
    } catch {
      return s.maxContextTokens ?? 8000;
    }
  }
  return s.maxContextTokens ?? 8000;
}
