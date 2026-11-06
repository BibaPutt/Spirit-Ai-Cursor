// Self-contained long-term context memory.
//
// Ports mem0's core algorithm (Apache-2.0) into a zero-dependency module so it
// works inside Spirit's Electron app with the user's own AI chain:
//
//   - Remembering costs ZERO extra LLM calls. When memory is enabled, Spirit's
//     system prompt carries a mem0-style extraction instruction
//     (ADDITIVE_EXTRACTION_PROMPT) that asks the model to end its reply with a
//     small "Key takeaways:" bullet list — but ONLY when something durable
//     happened (preferences, personal details, ongoing projects, important
//     takeaways, including from on-screen context). Spirit parses that section
//     out of the SAME response, strips it from the committed history, and
//     stores the facts. No fluff is kept because the model skips the section
//     when there is nothing important.
//   - Update/delete markers: bullets can be prefixed with [update <id>] or
//     [delete <id>] using ids shown in the recalled memory block, so facts can
//     be superseded or corrected without any extra LLM call.
//   - Recall is RAG on EVERY turn: the most relevant stored memories for the
//     current prompt (plus screen context) are BM25-ranked and auto-appended to
//     the system prompt. Memories are global — they carry across all sessions.
//   - BM25 scoring ported from mem0 utils/scoring.ts + utils/lemmatization.ts
//     (query-length-adaptive sigmoid normalization, Porter-ish stemmer fallback).
//   - linked_memory_ids link related facts so related memories stay grouped.
//   - Storage is plain JSON in <workspace>/context-memory.json (no SQLite /
//     no native deps), deduped by content hash. When the store grows past
//     COMPRESS_THRESHOLD entries it is auto-consolidated: the oldest memories
//     are merged into dense group summaries by Spirit's own AI (the only
//     background LLM call, and only when the store is large).
//
// Everything for this feature lives in electron/memory/.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getSettings, getWorkspaceFolder } from '../store/settings';
import { runPlainCompletion } from '../llm/providers/router';
import type { Message } from '../llm/prompt';
import {
  expandSynonyms,
  fuzzyTokenOverlap,
  tokenizeSignificant,
} from '../llm/text-tokens';

export type ContextMemoryItem = {
  id: string;
  text: string;
  hash: string;
  attributedTo: 'user' | 'assistant';
  createdAt: number;
  updatedAt: number;
  linkedMemoryIds: string[];
  sources: string[];
};

export type ExtractedMemory = {
  text: string;
  attributedTo: 'user' | 'assistant';
  updateId?: string;
  deleteId?: string;
  linkedMemoryIds?: string[];
  // Set when the model prefixed the bullet with [personal] — a durable fact
  // about who the user IS (name/role/language/...). Trusted over heuristics:
  // bypasses the worth-remembering gate (dedup still applies) and feeds the
  // self-learned Settings profile first.
  personal?: boolean;
};

const FILE_NAME = 'context-memory.json';
const MAX_MEMORIES = 200;
// When the store grows past this many entries, Spirit consolidates the OLDEST
// memories (keeping the most recent KEEP_RECENT verbatim) into a smaller set
// of dense group summaries via its own AI, then trims to MAX_MEMORIES.
const COMPRESS_THRESHOLD = 150;
const KEEP_RECENT = 60;
const DEFAULT_RECALL_LIMIT = 4;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Markers used to delimit the injected memory block inside a system message,
// so it can be cleanly stripped and re-injected on every turn (RAG).
const MEMORY_BLOCK_START = '<!--SPIRIT-MEMORY-->';
const MEMORY_BLOCK_END = '<!--/SPIRIT-MEMORY-->';

export function isContextMemoryEnabled(): boolean {
  return getSettings().contextMemoryEnabled === true;
}

function memoryFile(): string {
  return join(getWorkspaceFolder(), FILE_NAME);
}

export function hashText(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

async function loadMemories(): Promise<ContextMemoryItem[]> {
  try {
    const raw = await fs.readFile(memoryFile(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ContextMemoryItem =>
          !!m &&
          typeof m.text === 'string' &&
          typeof m.hash === 'string' &&
          (m.attributedTo === 'user' || m.attributedTo === 'assistant') &&
          typeof m.createdAt === 'number',
      )
      .map((m) => ({
        ...m,
        updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : m.createdAt,
        linkedMemoryIds: Array.isArray(m.linkedMemoryIds)
          ? m.linkedMemoryIds
          : [],
        sources: Array.isArray(m.sources) ? m.sources : [],
      }));
  } catch {
    return [];
  }
}

async function saveMemories(items: ContextMemoryItem[]): Promise<void> {
  await fs.mkdir(getWorkspaceFolder(), { recursive: true });
  await fs.writeFile(memoryFile(), JSON.stringify(items, null, 2), 'utf-8');
}

// BM25 scoring — ported from mem0 utils/scoring.ts + utils/lemmatization.ts
// (self-contained: no `natural` dependency, uses mem0's simpleStem fallback).
// Lemmatization lives in electron/llm/text-tokens.ts alongside the synonym
// map and fuzzy n-gram matcher so recall and the relevance gates agree.

export function getBm25Params(query: string): [number, number] {
  const numTerms = query.trim().split(/\s+/).filter(Boolean).length || 1;
  if (numTerms <= 3) return [5.0, 0.7];
  if (numTerms <= 6) return [7.0, 0.6];
  if (numTerms <= 9) return [9.0, 0.5];
  if (numTerms <= 15) return [10.0, 0.5];
  return [12.0, 0.5];
}

export function normalizeBm25(
  rawScore: number,
  midpoint: number,
  steepness: number,
): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

function bm25Rank(
  query: string,
  items: ContextMemoryItem[],
): Array<{ item: ContextMemoryItem; raw: number; norm: number }> {
  const q = tokenizeSignificant(query);
  const docs = items.map((i) => ({
    item: i,
    tokens: tokenizeSignificant(i.text),
  }));
  const n = docs.length;
  if (n === 0 || q.length === 0) return [];

  // Hybrid score = BM25 (as before) + synonym-expanded token overlap + fuzzy
  // n-gram overlap, so "precipitation" recalls the "rain cycle" memory and a
  // typo'd / inflected variant still matches. Weights: BM25 dominant, synonym
  // strong, fuzzy a tie-breaker.
  const qBm25 = q;
  const qExpanded = expandSynonyms(q);
  const avgdl = docs.reduce((sum, d) => sum + d.tokens.length, 0) / n;
  const df: Record<string, number> = {};
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df[t] = (df[t] ?? 0) + 1;
  }
  const idf: Record<string, number> = {};
  for (const t of qBm25) {
    idf[t] = Math.log(1 + (n - (df[t] ?? 0) + 0.5) / ((df[t] ?? 0) + 0.5));
  }

  const scored = docs.map((d, i) => {
    const dl = d.tokens.length;
    const tf: Record<string, number> = {};
    for (const t of d.tokens) tf[t] = (tf[t] ?? 0) + 1;
    let raw = 0;
    for (const t of qBm25) {
      const f = tf[t] ?? 0;
      if (f > 0) {
        raw +=
          (idf[t] ?? 0) *
          ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl)));
      }
    }
    const docSet = new Set(expandSynonyms(d.tokens));
    let synonymShared = 0;
    for (const t of qExpanded) if (docSet.has(t)) synonymShared++;
    const fuzzy = fuzzyTokenOverlap(q, d.tokens);
    return { item: d.item, raw, synonymShared, fuzzy };
  });

  const [midpoint, steepness] = getBm25Params(query);
  const denom = Math.max(1, q.length);
  return scored.map((s) => {
    const bm25 = s.raw > 0 ? normalizeBm25(s.raw, midpoint, steepness) : 0;
    const synonym = Math.min(1, s.synonymShared / denom);
    const fuzzy = Math.min(1, s.fuzzy / denom);
    return {
      item: s.item,
      raw: s.raw,
      norm: bm25 * 0.6 + synonym * 0.3 + fuzzy * 0.1,
    };
  });
}

// Keyword-overlap score (kept for small tests / quick checks).
export function scoreMemory(query: string, memory: ContextMemoryItem): number {
  const qTokens = tokenizeSignificant(query);
  if (qTokens.length === 0) return 0;
  const mTokens = new Set(tokenizeSignificant(memory.text));
  let score = 0;
  for (const t of qTokens) if (mTokens.has(t)) score++;
  return score;
}

// Staleness decay: as a memory ages without being touched it ranks lower at
// recall, so a year-old "User prefers X" stops crowding out the current
// "User prefers Y" even before the model corrects it. Fresh (<=2 weeks)
// memories are unweighted; older ones fade stepwise.
function stalenessDecay(updatedAt: number): number {
  const days = Math.max(0, (Date.now() - updatedAt) / 86_400_000);
  if (days <= 14) return 1;
  if (days <= 60) return 0.85;
  if (days <= 180) return 0.6;
  if (days <= 365) return 0.4;
  return 0.25;
}

// Recall the most relevant stored memories for the user's CURRENT PROMPT.
// BM25-ranked, staleness-decayed, thresholded, then recency. Deliberately
// takes ONLY the user's words — screen/OCR/app context describes what is on
// screen THIS moment, and folding it into the query made recall surface
// unrelated memories ("user likes yogurt" because a recipe happened to be
// visible), which is the #1 source of "why is this memory appearing?" noise.
export async function recallMemories(
  query: string,
  limit = DEFAULT_RECALL_LIMIT,
): Promise<ContextMemoryItem[]> {
  if (!isContextMemoryEnabled()) return [];
  const memories = await loadMemories();
  if (memories.length === 0) return [];
  // Floor > 0 so a lone fuzzy n-gram hit (tiny weight) can't surface a
  // spurious memory; real BM25 / synonym matches all land well above it.
  return bm25Rank(query, memories)
    .map((s) => ({
      ...s,
      effective: s.norm * stalenessDecay(s.item.updatedAt),
    }))
    .filter((s) => s.effective >= 0.06)
    .sort((a, b) => b.effective - a.effective || b.item.updatedAt - a.item.updatedAt)
    .slice(0, limit)
    .map((s) => s.item);
}

// System-prompt injection (RAG recall block + same-response capture instruction)

// Instruction block appended to the system prompt when memory is enabled. This
// is a condensed adaptation of mem0's ADDITIVE_EXTRACTION_PROMPT (role,
// attribute correctly, dedupe against listed memories, temporal grounding,
// self-contained facts, no fluff) but tuned for emitting "Key takeaways" inside
// the model's own reply so no separate extraction call is needed.
export function memoryRememberInstruction(): string {
  return [
    '# Long-term memory capture',
    'You may append a short "Key takeaways:" section at the END of your reply.',
    'Append it ONLY when this turn revealed durable facts worth remembering: user',
    'preferences, personal details, ongoing projects/plans, important takeaways, or',
    'facts from the on-screen context (screenshot OCR, selected text, clipboard,',
    'current app). Use "Key takeaways:" then one bullet per distinct fact.',
    '',
    'Rules (adapted from mem0 extraction guidelines):',
    '- PRIORITISE preferences and habits: the user\'s likes, dislikes, habits, and',
    '  goals are the most valuable facts ("User prefers X", "User is learning Y").',
    '- AVOID generic encyclopaedia-style facts with no personal anchor (e.g.',
    '  "Cows are domesticated ruminants used worldwide"). Only keep general',
    '  knowledge when it came up as an answer the user needs repeated.',
    '- Each takeaway is a self-contained factual statement about the user, with any',
    '  relative dates grounded (e.g. "this week" -> "the week of <today>").',
    '- Keep exact names, titles, numbers and qualifiers ("3 goals", "assistant',
    '  manager", "Osteria Francescana") — never generalize them away.',
    '- Attribute correctly: user-stated facts are "User ...". Assistant-provided',
    '  recommendations become "User was recommended ...".',
    '- Skip fluff, greetings, code snippets, and anything only relevant this one',
    '  moment. When in doubt, extract — a slightly redundant fact beats a lost one.',
    '- If a fact already appears in the Context memory list below, do NOT repeat it.',
    '- A new fact that restates a LISTED memory with a different value means the',
    '  listed memory is OUTDATED — replace it with [update <id>], never add a',
    '  competing memory about the same thing.',
    '- If a new fact REPLACES or corrects a listed memory, prefix the bullet with',
    '  "[update <id>]" using that memory\'s id. If a listed memory is now wrong,',
    '  prefix with "[delete <id>]".',
    '- If nothing durable happened, skip the section entirely.',
    '',
    'Personal facts (who the user IS — name, role/job, languages, timezone,',
    'city, contact): prefix the bullet with "[personal]". Tag ONLY facts that',
    'are genuinely useful later (the assistant will address them by name or',
    'tailor work to their role) — never tag for the sake of tagging. Do NOT',
    'repeat a listed memory: if the listed value changed, write ONE bullet',
    '"[update <id>] [personal] <new value>" instead of a competing twin. If',
    'nothing new about the user came up, write no [personal] bullet at all.',
    '',
    'Key takeaways:',
    '- ...',
    "- [personal] User's name is Ana",
    '- [update abcd1234] superseding fact ...',
    '- [update efgh5678] [personal] User now works as a designer',
  ].join('\n');
}

// Quality gate for extracted facts. Filters the "Cows are domesticated
// ruminants used worldwide for milk" style of generic encyclopaedia bullet
// while keeping anything personally anchored (a "User ..." fact, a
// preference, a number, a named entity). The extraction model defaults every
// bullet's attribution to "user", so the gate keys off the TEXT (does it
// reference the user?) rather than trusting the attribution field.
const GENERIC_DEFINITION_RE =
  /\b(?:is|are)\b[^.]{0,60}?\b(?:used|known|found|raised|domesticated|considered|regarded|refers?\s*to|can\s+be|commonly|typically|generally|widely)\b/i;
const PREFERENCE_VERBS_RE =
  /\b(?:likes?|prefers?|wants?|needs?|uses?|enjoys?|dislikes?|hates?|studies?|practices?|recommended|suggested|switched|started|stopped|bought|sold|ordered|applied|interviewed|moved|joined|hired|signed\s+up|working\s+(?:on|at)|learning|studying|building|writing|reading|planning|teaching|preparing|reviewing|fixing|upgrading)\b/i;

export function isWorthRemembering(
  text: string,
  attributedTo: 'user' | 'assistant',
): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  // Generic definitional statements are dropped regardless of attribution.
  if (GENERIC_DEFINITION_RE.test(t)) return false;
  // Anchored to the user's own words -> durable.
  if (/^user\b/i.test(t)) return true;
  // Assistant recommendations about the user ("User was recommended ...").
  if (
    attributedTo === 'assistant' &&
    /\b(?:recommended|suggested|was told|was advised)\b/i.test(t)
  ) {
    return true;
  }
  // A preference/action verb about someone or something durable.
  if (PREFERENCE_VERBS_RE.test(t)) return true;
  // Nothing anchored the fact to the user's situation — numbers and proper
  // names alone do NOT make a generic fact worth keeping ("Germany exported
  // 92bn in machinery", "Osaka hosts World Expo"). Encyclopaedic fluff, not a
  // memory about the user.
  return false;
}

// Near-duplicate similarity between two facts (Jaccard over significant
// tokens, deliberately NOT synonym-expanded — a conservative threshold here
// prevents merging distinct-but-related facts and silently dropping their
// extra detail). Above this threshold a new fact merges into the existing
// memory instead of adding a copy.
const NEAR_DUP_THRESHOLD = 0.85;

function nearDuplicateScore(a: string, b: string): number {
  const setA = new Set(tokenizeSignificant(a));
  const setB = new Set(tokenizeSignificant(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return union > 0 ? shared / union : 0;
}

// mem0 v2 decision-function port (no extra LLM call). mem0 classifies each new
// fact ADD vs UPDATE: a fact that AUGMENTS (adds detail to a stored fact about
// the same subject) or CONFLICTS (states a newer value for it) should REPLACE
// the stored entry instead of stacking a competing twin — that is what kills
// "User prefers brief answers" lingering next to "User now prefers detailed".
// Pure Jaccard overlap alone over-merges ("commutes by train"/"commutes by
// bike" share {commute, user} and score 0.5), so the decision requires the
// same subject (>=3 shared significant tokens) AND comparable scope (the new
// fact is a re-statement or supersession — between 2/3 and 4x the length of
// the stored one, never a short bolt-on superseding a rich entry).
const AUGMENT_SIMILARITY_MIN = 0.45;
const AUGMENT_SHARED_MIN = 3;
const AUGMENT_RATIO_MIN = 2 / 3;
const AUGMENT_RATIO_MAX = 4;

// Returns the index of the stored memory the new fact supersedes, or -1.
function findAugmentedItem(
  text: string,
  existing: ContextMemoryItem[],
): number {
  const len = text.trim().split(/\s+/).length;
  for (let i = 0; i < existing.length; i++) {
    const m = existing[i];
    const overlap = nearDuplicateScore(text, m.text);
    if (overlap < AUGMENT_SIMILARITY_MIN) continue;
    const a = new Set(tokenizeSignificant(text));
    const b = new Set(tokenizeSignificant(m.text));
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    if (shared < AUGMENT_SHARED_MIN) continue;
    const mlen = m.text.trim().split(/\s+/).length;
    const ratio = len / mlen;
    if (ratio < AUGMENT_RATIO_MIN || ratio > AUGMENT_RATIO_MAX) continue;
    return i;
  }
  return -1;
}

// Relative-age label for a memory's block annotation, so the model can see how
// fresh a recalled fact is and discount old ones ("treat a twin entry with a
// younger timestamp as the winner").
function memoryAgeLabel(ms: number): string {
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function memorySourceLabel(sources: string[]): string {
  const known = Array.from(new Set(sources))
    .filter((s) => !!s && s !== 'conversation')
    .slice(0, 2);
  if (known.length === 0) return '';
  return ` · from ${known.join(', ')}`;
}

// Render recalled memories as a block to inject into the system prompt. Each
// entry carries its short id (for [update <id>]/[delete <id>]) plus a relative
// age and the source it was learned from, so the model can weigh freshness.
export function memoryContextBlock(memories: ContextMemoryItem[]): string {
  if (memories.length === 0) return '';
  const lines = memories
    .map(
      (m) =>
        `- [${m.id}] ${m.text} (${memoryAgeLabel(m.updatedAt)}${memorySourceLabel(m.sources)})`,
    )
    .join('\n');
  return [
    '# Context memory',
    'Facts learned in earlier conversations. Use them only when relevant; do not',
    'repeat them back unless asked. Each is tagged with an id for [update <id>] /',
    '[delete <id>] in Key takeaways and a relative age — a younger memory on the',
    'same topic wins, treat older entries as possibly stale.',
    lines,
  ].join('\n');
}

// Strip any previously injected memory block from a system message's content.
export function stripMemoryBlock(content: string): string {
  const start = content.indexOf(MEMORY_BLOCK_START);
  if (start === -1) return content;
  const end = content.indexOf(MEMORY_BLOCK_END, start);
  if (end === -1) return content.slice(0, start).trimEnd();
  return (content.slice(0, start) + content.slice(end + MEMORY_BLOCK_END.length)).trimEnd();
}

// RAG: recall memories for the user's CURRENT PROMPT and inject the
// instruction + recalled block into the system message of `messages`. Returns a
// new array; the caller decides what to commit to history (use stripMemoryBlock).
// NOTE: `screenContext` is deliberately NOT part of the recall query — screen
// content is this-moment evidence, not durable memory (see recallMemories).
export async function withMemoryBlock(
  messages: Message[],
  query: string,
  _screenContext = '',
  limit = DEFAULT_RECALL_LIMIT,
): Promise<Message[]> {
  if (!isContextMemoryEnabled()) return messages;
  const recalled = await recallMemories(query, limit);
  // Recall visibility: one log line per turn so the user can see what memory
  // actually surfaced (and what didn't) in the Spirit log output.
  if (recalled.length > 0) {
    const slice = query.length > 80 ? query.slice(0, 80) + '…' : query;
    console.log(
      `[memory] recall="${slice.replace(/\s+/g, ' ').trim()}" → ${recalled.length} matched: ${recalled
        .map((m) => m.id)
        .join(', ')}`,
    );
  }
  const block = [memoryRememberInstruction(), memoryContextBlock(recalled)]
    .filter(Boolean)
    .join('\n\n');
  const out = messages.map((m) => ({ ...m }));
  const sys = out[0];
  if (!sys || sys.role !== 'system' || typeof sys.content !== 'string') {
    return out;
  }
  const base = stripMemoryBlock(sys.content);
  sys.content = `${base}\n\n${MEMORY_BLOCK_START}\n${block}\n${MEMORY_BLOCK_END}`;
  return out;
}

// Same-response parsing: split the "Key takeaways" section off the model's reply

// Find the LAST "Key takeaways" header line and parse the bullet list after it.
// Returns the reply without the section, plus the parsed takeaways.
export function splitRememberSection(
  reply: string,
): { cleaned: string; takeaways: ExtractedMemory[] } {
  const lines = reply.split(/\r?\n/);
  const headerRe = /^\s*(?:#{1,3}\s*)?\*{0,2}\s*key takeaways?\s*\*{0,2}\s*:?\s*$/i;
  let headerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (headerRe.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return { cleaned: reply, takeaways: [] };

  const takeaways: ExtractedMemory[] = [];
  let i = headerIndex + 1;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (!bullet) break;
    const parsed = parseTakeawayBullet(bullet[1].trim());
    if (parsed) takeaways.push(parsed);
    i++;
  }

  const cleaned = lines
    .slice(0, headerIndex)
    .join('\n')
    .replace(/\s+$/, '')
    .trimEnd();
  return { cleaned, takeaways };
}

function parseTakeawayBullet(raw: string): ExtractedMemory | null {
  let text = raw;
  let updateId: string | undefined;
  let deleteId: string | undefined;
  let personal = false;

  // Markers compose in any order: "[personal] [update id] ...",
  // "[update id] [personal] ...". Strip all leading markers first.
  for (;;) {
    const personalMatch = text.match(/^\[personal\]\s*(.*)$/i);
    if (personalMatch) {
      personal = true;
      text = personalMatch[1];
      continue;
    }
    break;
  }

  const updateMatch = text.match(/^\[update\s+([a-zA-Z0-9_-]+)\]\s*(.*)$/i);
  if (updateMatch) {
    updateId = updateMatch[1];
    text = updateMatch[2];
    // Allow the personal tag after the update marker too.
    const trailing = text.match(/^\[personal\]\s*(.*)$/i);
    if (trailing) {
      personal = true;
      text = trailing[1];
    }
  } else {
    const deleteMatch = text.match(/^\[delete\s+([a-zA-Z0-9_-]+)\]\s*(.*)$/i);
    if (deleteMatch) {
      deleteId = deleteMatch[1];
      text = deleteMatch[2];
    }
  }
  text = text.trim();
  // A [delete <id>] marker is valid even with no replacement text — the model
  // often writes the marker alone. Updates need content to store.
  if (deleteId) return { text, attributedTo: 'user', deleteId, personal };
  if (text.length < 4) return null;

  const attributedTo =
    /^user\b|recommended|suggested|was told|was advised/i.test(text)
      ? 'user'
      : 'assistant';
  return { text, attributedTo, updateId, deleteId, personal };
}

// Parse a JSON {"memory":[...]} reply (used by the background consolidation
// call). Kept for tests and the LLM-driven compression path.
export function parseExtractionReply(raw: string): ExtractedMemory[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/g, '').trim();
  try {
    const obj = JSON.parse(trimmed) as { memory?: unknown };
    if (!obj || !Array.isArray(obj.memory)) return [];
    const out: ExtractedMemory[] = [];
    for (const entry of obj.memory as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as {
        text?: unknown;
        attributed_to?: unknown;
        linked_memory_ids?: unknown;
      };
      if (typeof rec.text !== 'string') continue;
      const text = rec.text.trim();
      if (text.length < 4) continue;
      const attributedTo =
        rec.attributed_to === 'assistant' || rec.attributed_to === 'user'
          ? rec.attributed_to
          : 'user';
      const linkedMemoryIds = Array.isArray(rec.linked_memory_ids)
        ? rec.linked_memory_ids.filter(
            (x): x is string => typeof x === 'string',
          )
        : undefined;
      out.push({ text, attributedTo, linkedMemoryIds });
    }
    return out;
  } catch {
    return [];
  }
}

// Store merge (no LLM call): apply update/delete markers, dedupe, link, save

// Merge parsed takeaways into the store. Never throws.
// Hermes USER.md-style self-learning: pull durable personal facts out of
// extracted takeaways so they can auto-fill the Settings profile (name/role/
// language). Conservative on purpose — only explicit "User's X is Y" shapes,
// first value wins, nothing inferred. Pure (unit-tested). The caller decides
// persistence (settings.applyLearnedProfile fills empty fields only).
export interface LearnedProfile {
  name?: string;
  role?: string;
  preferredLanguage?: string;
}

const NAME_RES = [
  /(?:user'?s name is|name is|call me|i'?m called)\s+([A-Z][a-zA-Z'’-]{1,30}(?:\s+[A-Z][a-zA-Z'’-]{1,30}){0,2})/,
  /^name\s*:\s*([A-Z][a-zA-Z'’-]{1,30}(?:\s+[A-Z][a-zA-Z'’-]{1,30}){0,2})/i,
];
const ROLE_RES = [
  /user (?:works? as|is) (?:an? )?([a-zA-Z][a-zA-Z .&-]{2,60}?)(?:\.|$)/i,
  /^(?:role|job|occupation)\s*:\s*([a-zA-Z][a-zA-Z .&-]{2,60})/i,
];
const LANG_RES = [
  /user (?:prefers|speaks|wants) ([a-zA-Z]+) (?:replies|responses|language)/i,
  /^(?:language|preferred language)\s*:\s*([a-zA-Z]+)/i,
];

function firstMatch(res: RegExp[], text: string): string | null {
  for (const re of res) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim().replace(/\.$/, '');
  }
  return null;
}

export function extractProfileUpdates(
  takeaways: Array<{ text: string; personal?: boolean }>,
): LearnedProfile {
  const out: LearnedProfile = {};
  // Model-tagged [personal] bullets first — the extractor already judged them
  // durable identity facts, so they win over untagged regex matches.
  const ordered = [...takeaways].sort(
    (a, b) => Number(b.personal === true) - Number(a.personal === true),
  );
  for (const t of ordered) {
    const text = t.text.trim();
    if (!out.name) {
      const name = firstMatch(NAME_RES, text);
      if (name && !/^(user|assistant|unknown)$/i.test(name)) out.name = name;
    }
    if (!out.role) {
      const role = firstMatch(ROLE_RES, text);
      if (role) out.role = role;
    }
    if (!out.preferredLanguage) {
      const lang = firstMatch(LANG_RES, text);
      if (lang) out.preferredLanguage = lang;
    }
    if (out.name && out.role && out.preferredLanguage) break;
  }
  return out;
}

export async function rememberTakeaways(
  takeaways: ExtractedMemory[],
  sources: string[] = [],
): Promise<{ added: number; updated: number; deleted: number; total: number; addedTexts: string[] }> {
  if (!isContextMemoryEnabled() || takeaways.length === 0) {
    return { added: 0, updated: 0, deleted: 0, total: 0, addedTexts: [] };
  }
  try {
    let items = await loadMemories();
    const seen = new Set(items.map((m) => m.hash));
    const now = Date.now();
    let added = 0;
    let updated = 0;
    let deleted = 0;
    const addedTexts: string[] = [];

    for (const t of takeaways) {
      if (t.deleteId) {
        const before = items.length;
        items = items.filter((m) => m.id !== t.deleteId);
        deleted += before - items.length;
        if (deleted > 0) {
          // Drop references to the removed memory everywhere.
          items = items.map((m) => ({
            ...m,
            linkedMemoryIds: m.linkedMemoryIds.filter(
              (id) => id !== t.deleteId,
            ),
          }));
        }
        continue;
      }

      if (t.updateId) {
        const idx = items.findIndex((m) => m.id === t.updateId);
        if (idx !== -1) {
          const hash = hashText(t.text);
          // [personal] bullets bypass the worth gate — the model already
          // judged the fact durable by tagging it (dedup below still applies).
          if (hash !== items[idx].hash && (t.personal === true || isWorthRemembering(t.text, t.attributedTo ?? 'user'))) {
            items[idx] = {
              ...items[idx],
              text: t.text,
              hash,
              updatedAt: now,
            };
            updated++;
          }
        }
        continue;
      }

      if (t.personal !== true && !isWorthRemembering(t.text, t.attributedTo ?? 'user')) continue;

      const hash = hashText(t.text);
      if (seen.has(hash)) continue;
      // Near-duplicate merge: if the new fact is essentially the same as an
      // existing one (synonym-aware), refresh it and fold in the new sources
      // instead of stacking a copy. Counts as neither added nor updated — it
      // is a no-op refresh.
      let merged = false;
      if (sources.length > 0) {
        for (let i = 0; i < items.length; i++) {
          if (nearDuplicateScore(t.text, items[i].text) >= NEAR_DUP_THRESHOLD) {
            const mergedSources = Array.from(
              new Set([...items[i].sources, ...sources]),
            );
            items[i] = {
              ...items[i],
              text: t.text,
              hash,
              updatedAt: now,
              sources: mergedSources,
            };
            seen.add(hash);
            merged = true;
            break;
          }
        }
      }
      if (merged) continue;
      // mem0 UPDATE: the new fact augments or contradicts an existing one
      // about the same subject. The newest statement wins in place — no twin.
      const augmentIdx = findAugmentedItem(t.text, items);
      if (augmentIdx !== -1) {
        const mergedSources = Array.from(
          new Set([...items[augmentIdx].sources, ...sources]),
        );
        items[augmentIdx] = {
          ...items[augmentIdx],
          text: t.text,
          hash,
          updatedAt: now,
          sources: mergedSources,
        };
        seen.add(hash);
        updated++;
        continue;
      }
      seen.add(hash);
      const item: ContextMemoryItem = {
        id: hash.slice(0, 12),
        text: t.text,
        hash,
        attributedTo: t.attributedTo ?? 'user',
        createdAt: now,
        updatedAt: now,
        linkedMemoryIds: t.linkedMemoryIds ?? linkNewMemory(t.text, items),
        sources,
      };
      items.push(item);
      added++;
      if (addedTexts.length < 3) addedTexts.push(t.text);
    }

    const trimmed = await ensureBounded(items);
    await saveMemories(trimmed);
    return { added, updated, deleted, total: trimmed.length, addedTexts };
  } catch (err) {
    console.warn('[contextMemory] rememberTakeaways failed:', err);
    return { added: 0, updated: 0, deleted: 0, total: 0, addedTexts: [] };
  }
}

// Heuristic linking: find existing memories that share >=2 significant tokens
// with the new fact and return their ids (mem0 links via LLM; this is a cheap
// deterministic stand-in when the model didn't provide linked_memory_ids).
function linkNewMemory(text: string, existing: ContextMemoryItem[]): string[] {
  const tokens = new Set(tokenizeSignificant(text));
  if (tokens.size === 0) return [];
  const linked: string[] = [];
  for (const m of existing) {
    const mt = new Set(tokenizeSignificant(m.text));
    let shared = 0;
    for (const t of tokens) if (mt.has(t)) shared++;
    if (shared >= 2) linked.push(m.id);
  }
  return linked.slice(0, 4);
}

// Auto-consolidation: once the store passes COMPRESS_THRESHOLD, merge the
// OLDEST memories (everything before the KEEP_RECENT most recent) into a
// smaller set of dense group summaries using Spirit's own AI, then cap at
// MAX_MEMORIES. Never throws — on any failure it falls back to truncation.
async function ensureBounded(
  items: ContextMemoryItem[],
): Promise<ContextMemoryItem[]> {
  if (items.length <= COMPRESS_THRESHOLD) return items;
  const recent = items.slice(-KEEP_RECENT);
  const old = items.slice(0, items.length - KEEP_RECENT);
  if (old.length === 0) return items.slice(-MAX_MEMORIES);
  try {
    const summaries = await compressOldMemories(old);
    return [...summaries, ...recent].slice(-MAX_MEMORIES);
  } catch {
    return items.slice(-MAX_MEMORIES);
  }
}

// Ask Spirit's configured AI to merge a batch of old memories into a much
// smaller list of consolidated summaries. The only background LLM call.
export async function compressOldMemories(
  old: ContextMemoryItem[],
): Promise<ContextMemoryItem[]> {
  if (old.length === 0) return [];
  const system = [
    'You consolidate long-term memories. Given a list of facts learned about a',
    'user in earlier conversations, merge them into the SMALLEST number of',
    'grouped summaries that still preserves every durable detail.',
    '',
    'Rules:',
    '- Group related facts about the same topic, project, or person into one entry.',
    '- Keep concrete specifics (names, preferences, numbers) — do not drop them.',
    '- Remove redundancy: state each fact once.',
    '- Each summary is one dense sentence or a short bulleted list.',
    '',
    'Reply with STRICT JSON only — a single object:',
    '{"memory":[{"text":"..."}]}',
  ].join('\n');

  const user = old.map((m) => `- ${m.text}`).join('\n');

  const reply = await runPlainCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { tier: 'capable' },
  );

  const parsed = parseExtractionReply(reply);
  const now = Date.now();
  const out: ContextMemoryItem[] = [];
  const seen = new Set<string>();
  for (const mem of parsed) {
    const hash = hashText(mem.text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      id: hash.slice(0, 12),
      text: mem.text,
      hash,
      attributedTo: 'user',
      createdAt: now,
      updatedAt: now,
      linkedMemoryIds: [],
      sources: [],
    });
  }
  return out.length > 0 && out.length < old.length ? out : old;
}

export async function getAllMemories(): Promise<ContextMemoryItem[]> {
  return loadMemories();
}

export async function clearMemories(): Promise<void> {
  await fs.mkdir(getWorkspaceFolder(), { recursive: true });
  await fs.writeFile(memoryFile(), JSON.stringify([]), 'utf-8');
}

// Delete one memory by id (memory-manager UI). Also purges references to it
// in other memories' linkedMemoryIds. Returns false when nothing matched.
export async function deleteMemory(id: string): Promise<boolean> {
  try {
    let items = await loadMemories();
    const before = items.length;
    items = items.filter((m) => m.id !== id);
    if (items.length === before) return false;
    items = items.map((m) => ({
      ...m,
      linkedMemoryIds: m.linkedMemoryIds.filter((x) => x !== id),
    }));
    await saveMemories(items);
    return true;
  } catch (err) {
    console.warn('[contextMemory] deleteMemory failed:', err);
    return false;
  }
}

// Replace one memory's text by id (memory-manager UI). Returns false when the
// id is unknown or the new text is too short.
export async function updateMemory(id: string, text: string): Promise<boolean> {
  try {
    const t = text.trim();
    if (t.length < 4) return false;
    let items = await loadMemories();
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    const hash = hashText(t);
    if (hash !== items[idx].hash) {
      items[idx] = {
        ...items[idx],
        text: t,
        hash,
        updatedAt: Date.now(),
      };
      await saveMemories(items);
    }
    return true;
  } catch (err) {
    console.warn('[contextMemory] updateMemory failed:', err);
    return false;
  }
}
