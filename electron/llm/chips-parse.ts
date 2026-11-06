// Pure parsing/normalization for AI-generated action suggestion chips. This
// module never touches Electron or the provider layer so the vitest suite can
// exercise it directly.

import { createHash } from 'node:crypto';
import type { Message } from './prompt';

export type SuggestionChip = {
  label: string;
  icon: string;
  // Hidden instruction submitted when the chip is tapped (see types.ts).
  prompt?: string;
  // True = tapping the chip forces web search for the run (offline search
  // chips do a REAL web search in the box instead of a memory-only answer).
  web?: boolean;
};

export const MAX_CHIPS = 3;
export const CHIP_LABEL_MAX = 45;
export const ICON_NAME_MAX = 40;
export const CHIP_PROMPT_MAX = 400;
// The model's agreed escape hatch: when no safe, useful chip exists it returns
// exactly this marker instead of JSON.
export const SAFETY_MARKER = 'INVALID_DUE_TO_SAFETY_REASONS';

export function cacheKeyFor(contextText: string): string {
  return createHash('sha1').update(contextText).digest('hex');
}

// session context ("a bit of summarised context")
// The chip model sees only the CURRENT screen text. When the user is mid-task
// in an ongoing session (the box stays open across turns), chips are far more
// useful if they also know where the conversation left off. We don't burn an
// extra LLM call to summarise it — a compact excerpt of the last few turns
// IS the "summarised context": enough signal, zero extra cost, no chat model
// involved. The system prompt then asks for ONE chip grounded in it, with the
// other two from the screen context as usual.

const SESSION_CTX_TURNS = 3; // last 3 user/assistant pairs
const SESSION_CTX_TURN_CHARS = 200; // per line cap
const SESSION_CTX_MAX_CHARS = 1400; // whole block cap

function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// Build the brief conversation excerpt from a session's message history.
// Pure string logic (no Electron, no provider) so vitest can exercise it.
export function summarizeSessionContext(messages: Message[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = messageText(m).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    turns.push({ role: m.role, text });
  }
  const recent = turns.slice(-SESSION_CTX_TURNS * 2);
  const lines: string[] = [];
  let budget = SESSION_CTX_MAX_CHARS;
  for (const t of recent) {
    const clipped =
      t.text.length > SESSION_CTX_TURN_CHARS
        ? `${t.text.slice(0, SESSION_CTX_TURN_CHARS)}…`
        : t.text;
    const line = `${t.role === 'user' ? 'User' : 'Spirit'}: ${clipped}`;
    if (budget - line.length < 0) break;
    lines.push(line);
    budget -= line.length;
  }
  return lines.join('\n');
}

// normalization

function normalizeLabel(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  // Strip list/bullet/quote decorations a chatty model may add.
  s = s.replace(/^[-*•▶◦▪]\s+/, '');
  s = s.replace(/^\(\d+\)\s+/, '').replace(/^\d+[.)]\s+/, '');
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  // A weak model wraps a term in quote marks mid-label: "Explain 'Defect Ide'"
  // → "Explain Defect Ide". Only fires when the opener is in quote position
  // (whitespace before it), so real apostrophes glued to letters — "you're",
  // "Spirit's" — are never touched.
  s = s.replace(
    /\s+(['"`\u2018\u2019\u201C\u201D])([^'"`\u2018\u2019\u201C\u201D]+)\1(?=\s|$)/g,
    ' $2',
  );
  // Dangling opener with no closing mark: "Explain 'rigger detection attached"
  // → "Explain rigger detection attached".
  s = s.replace(/\s+['"`\u2018\u2019\u201C\u201D](?=\S)/g, ' ');
  // Strip annotation tags a chatty model leaks into chip labels: the exact
  // pixel coordinates never belong on a button ("Save File [BOX:100,50:320,
  // 80:Save File]"). Runs BEFORE whitespace collapse so the tag + its inline
  // prefix collapse one step: "Save File [BOX:el#:x]" → "Save File".
  s = s.replace(/\s*\[(?:POINT|BOX|ARROW):[^\]]*\]/g, ' ');
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function clampLabel(label: string): string {
  return label.length > CHIP_LABEL_MAX ? label.slice(0, CHIP_LABEL_MAX) : label;
}

function clampPrompt(prompt: string): string {
  return prompt.length > CHIP_PROMPT_MAX ? prompt.slice(0, CHIP_PROMPT_MAX) : prompt;
}

export function normalizeIconName(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return '';
  const cleaned = s
    .replace(/^icon[-_:]/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, ICON_NAME_MAX);
}

function toChip(label: string, icon: string, prompt?: string): SuggestionChip {
  const chip: SuggestionChip = { label: clampLabel(label), icon: normalizeIconName(icon) };
  if (prompt && prompt.trim()) chip.prompt = clampPrompt(prompt.trim());
  return chip;
}

function chipsFromArray(value: unknown): SuggestionChip[] | null {
  if (!Array.isArray(value)) return null;
  const chips: SuggestionChip[] = [];
  for (const item of value) {
    if (chips.length >= MAX_CHIPS) break;
    if (item === null || typeof item !== 'object') continue;
    const { label, icon, prompt } = item as { label?: unknown; icon?: unknown; prompt?: unknown };
    let labelVal = label;
    if (typeof labelVal !== 'string') {
      // A weak model mangles the key into "label arc" (keeps the "label"
      // prefix but appends junk). Accept any member whose key starts with
      // "label" so the chip still shows.
      const obj = item as Record<string, unknown>;
      const labelKey = Object.keys(obj).find((k) => /^label\b/i.test(k));
      if (labelKey) labelVal = obj[labelKey];
    }
    if (typeof labelVal !== 'string') continue;
    const cleaned = normalizeLabel(labelVal);
    if (!cleaned) continue;
    chips.push(
      toChip(
        cleaned,
        typeof icon === 'string' ? icon : '',
        typeof prompt === 'string' ? prompt : undefined,
      ),
    );
  }
  return chips.length > 0 ? chips : null;
}

// Weak quantized local models routinely mangle the JSON contract. Repair the
// common failure modes before strict JSON.parse so their output is usable:
//   - semicolon as key/value separator:   "label"; "execute"   →   "label": "execute"
//   - missing commas between fields:      "a": "b"\n"c": "d"   →   "a": "b",\n"c": "d"
//   - missing commas between objects:     }\n{                  →   },\n{
//   - unquoted keys:                      {label: "x"}          →   {"label": "x"}
//   - single-quoted keys/values:          {'label': 'x'}        →   {"label": "x"}
//   - smart/curly quotes copied from text
//   - trailing commas
// Each rewrite is conservative: it only fires on shapes that can't appear in
// valid JSON (e.g. `";"` between two quotes), so well-formed output is never
// touched. Only called after a strict parse already failed.
function repairChipJson(body: string): string {
  let s = body;
  s = s.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  s = s.replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":');
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  s = s.replace(/([\[{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  s = s.replace(/";\s*"/g, '": "');
  // The model wrote the value separator as `=` instead of `:`. Two shapes
  // appear in the wild — `"key"="value"` and `"key="value"` (equals glued
  // inside the key string). Both only fire at a member start (right after
  // `{` or `,`), never inside a quoted value.
  s = s.replace(/([{,]\s*)"([A-Za-z_][A-Za-z0-9_]*)"\s*=\s*"([^"]*)"(\s*[,}]|$)/g, '$1"$2": "$3"$4');
  s = s.replace(/([{,]\s*)"([A-Za-z_][A-Za-z0-9_]*?)="([^"]*)"(\s*[,}]|$)/g, '$1"$2": "$3"$4');
  s = s.replace(/("\s*)(\r?\n)(\s*)(?=")/g, '$1,$2$3');
  s = s.replace(/}(\s*)(\r?\n)(\s*)(?=\s*\{)/g, '},$2$3');
  // The model closes the array after EVERY object: `[{...}], [{...}]`, and
  // sometimes loses the next object's opening brace entirely: `}],"label":…`.
  // Both only appear where a valid `]` could never sit, so folding them into
  // a `}, {` separator can't touch well-formed output.
  s = s.replace(/}\]\s*(?:,\s*)?(?:\[\s*)?\{/g, '}, {');
  s = s.replace(/}\]\s*,?\s*(?="[A-Za-z_][A-Za-z0-9_]*"\s*:)/g, '}, {');
  // The model wrote the comma INSIDE the quoted value, swallowing the next
  // key's opening quote: `"label":"Translate,"icon":…` → `"label":"Translate","icon":…`.
  // Fires only when a quoted value ends with `,` directly before a `"key":`,
  // which cannot happen in valid member pairs.
  s = s.replace(/"([^"\\]+),("([A-Za-z_][A-Za-z0-9_]*)"\s*:)/g, '"$1",$2');
  s = s.replace(/(")\s+(?="[A-Za-z_][A-Za-z0-9_]*"\s*:)/g, '$1, ');
  // The model dropped the key/value separator: {"label Mac", "icon": ...}
  // → {"label": " Mac", "icon": ...}. Only fires when a "label …" string sits
  // where an object member must be (right after `{` or `,`), so well-formed
  // `"label":` pairs and prose inside values are never touched.
  s = s.replace(/([{,]\s*)"([Ll]abel)([^"\\]+)"\s*,/g, '$1"$2": "$3",');
  s = s.replace(/,\s*([}\]])/g, '$1');
  // A line that opens an object with `(` instead of `{` (seen in the wild:
  // `("label": "summarize", ...`). Only fires when the paren is directly
  // followed by a double-quoted key, so prose in other output is untouched.
  s = s.replace(/^\s*\((?=")/gm, '{');
  return s;
}

// Strict JSON parse of a full array (or a single object) into chips. Returns
// null when the text is not parseable — the caller decides how to recover.
function tryParseChipArray(body: string): SuggestionChip[] | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) ? chipsFromArray(parsed) : chipsFromArray([parsed]);
  } catch {
    return null;
  }
}

// The model emitted a broken array that repair + full parse still can't read
// (e.g. `"label 同, "icon": ...` — a key whose value is lost). Salvage any
// well-formed `{...}` object inside it instead of giving up entirely.
function salvageObjectChunks(body: string): SuggestionChip[] | null {
  const objs = body.match(/\{[^{}]*\}/g);
  if (!objs || objs.length === 0) return null;
  const chips: SuggestionChip[] = [];
  for (const obj of objs) {
    if (chips.length >= MAX_CHIPS) break;
    let arr = tryParseChipArray(obj);
    // A chunk that repair + whole-body parse couldn't read (the array was
    // broken before it, so the whole-body repair ran but still failed) may
    // still be fixable on its own — e.g. `"icon="mail"` inside an otherwise
    // valid object. Retry each chunk individually before giving up on it.
    if ((!arr || arr.length === 0) && obj.includes('=')) {
      const repaired = repairChipJson(obj);
      if (repaired !== obj) arr = tryParseChipArray(repaired);
    }
    if (arr && arr.length > 0) chips.push(arr[0]);
  }
  return chips.length > 0 ? chips : null;
}

// The model got cut off mid-array (output budget / token cap), so the array
// never closes but every completed object before the cut is still valid.
// Walk backwards from the last `}` and try parsing each shorter prefix as a
// complete array so the finished chips survive instead of showing (none).
function salvageTruncatedArray(body: string): SuggestionChip[] | null {
  let idx = body.lastIndexOf('}');
  let tries = 0;
  while (idx !== -1 && tries < 8) {
    const prefix = body.slice(0, idx + 1).trim();
    if (prefix.startsWith('[')) {
      const candidate = prefix.endsWith(']') ? prefix : `${prefix}]`;
      const chips = tryParseChipArray(candidate);
      if (chips) return chips;
      const repaired = repairChipJson(candidate);
      if (repaired !== candidate) {
        const fromRepaired = tryParseChipArray(repaired);
        if (fromRepaired) return fromRepaired;
      }
      const salvaged = salvageObjectChunks(candidate);
      if (salvaged) return salvaged;
    }
    const next = body.lastIndexOf('}', idx - 1);
    if (next === idx) break;
    idx = next;
    tries += 1;
  }
  return null;
}

// Raw JSON fragments that failed every parse attempt must NEVER surface as
// chip labels (that's how `[{"label 同, ...` junk ended up on the pills).
function looksLikeJsonJunk(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('}') || t.startsWith(']')) return true;
  if (t.startsWith('"') && /[;:]/.test(t)) return true;
  return /"[^"]*"\s*[:;]\s*"/.test(t);
}

// A single JSON line object: {"label":"…","icon":"…"} (or the "icon | label"
// and "label (icon)" shapes a lazy model may emit). Weak models also paste
// each chip as its own one-element array on a line — [{"label":"…",…}] — so
// that shape is accepted too.
function parseLine(line: string): SuggestionChip | null {
  const t = line.trim();
  if (!t) return null;
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const parsed = JSON.parse(t) as { label?: unknown; icon?: unknown };
      if (typeof parsed.label === 'string') {
        const chips = chipsFromArray([parsed]);
        return chips ? chips[0] : null;
      }
    } catch {
      /* not strict JSON — fall through */
    }
    const repaired = repairChipJson(t);
    if (repaired !== t) {
      try {
        const parsed = JSON.parse(repaired) as { label?: unknown; icon?: unknown };
        if (typeof parsed.label === 'string') {
          const chips = chipsFromArray([parsed]);
          return chips ? chips[0] : null;
        }
      } catch {
        /* still broken — fall through */
      }
    }
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    try {
      const parsed = JSON.parse(t) as unknown[];
      const chips = chipsFromArray(parsed);
      if (chips && chips.length > 0) return chips[0];
    } catch {
      /* not strict JSON — fall through */
    }
    const repaired = repairChipJson(t);
    if (repaired !== t) {
      try {
        const parsed = JSON.parse(repaired) as unknown[];
        const chips = chipsFromArray(parsed);
        if (chips && chips.length > 0) return chips[0];
      } catch {
        /* still broken — fall through */
      }
    }
  }

  // A line that opens with a brace/bracket or a quoted key and still failed
  // JSON parsing is a raw JSON fragment — never promote it to a chip label
  // (that's how `[{"label 同, ...` garbage ended up on the pills).
  if (looksLikeJsonJunk(t)) return null;
  const pipe = t.split(/\s*\|\s*/);
  if (pipe.length === 2 && pipe[0].trim() && pipe[1].trim()) {
    const label = normalizeLabel(pipe[1]);
    if (label) return toChip(label, pipe[0]);
  }
  const paren = t.match(/^(.*?)\s*\(([a-z0-9_-]{2,40})\)$/i);
  if (paren && paren[1].trim()) {
    const label = normalizeLabel(paren[1]);
    if (label) return toChip(label, paren[2]);
  }
  const label = normalizeLabel(t);
  if (!label) return null;
  return toChip(label, '');
}

// Parse a model's chip-suggestion response into a clean, bounded list. Returns
// an empty array for a safety refusal or junk output.
export function parseChipSuggestions(raw: string): SuggestionChip[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];
  if (text.toUpperCase().includes(SAFETY_MARKER)) return [];

  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  // 1) Strict JSON.
  const strict = tryParseChipArray(body);
  if (strict) return stripCopyChips(strict);

  // 2) Weak models mangle the JSON (semicolons, missing commas, unquoted
  //    keys, smart quotes…). Repair those shapes and retry the whole body.
  const repaired = repairChipJson(body);
  if (repaired !== body) {
    const fromRepaired = tryParseChipArray(repaired);
    if (fromRepaired) return stripCopyChips(fromRepaired);
  }

  // 3) The body is too broken to parse as a whole (a key lost its value, a
  //    stray `(` line, a truncated object…). Salvage any well-formed `{...}`
  //    object inside it. Run on BOTH the original and the repaired text —
  //    a body with one salvageable object and nothing to repair otherwise
  //    would otherwise be dropped entirely.
  const salvaged = salvageObjectChunks(repaired === body ? body : repaired);
  if (salvaged) return stripCopyChips(salvaged);

  // 3b) Truncated array: the body opens with `[` but was cut off before the
  //     closing bracket. Salvage the longest parseable prefix so the finished
  //     chips survive instead of showing (none).
  if (body.startsWith('[')) {
    const fromTruncated = salvageTruncatedArray(repaired === body ? body : repaired);
    if (fromTruncated) return stripCopyChips(fromTruncated);
  }

  // 4) Line fallback: plain text / "icon | label" / "label (icon)" lines.
  //    Raw JSON fragments that failed every parse attempt are skipped — they
  //    must never surface as chip labels.
  const seen = new Set<string>();
  const chips: SuggestionChip[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (chips.length >= MAX_CHIPS) break;
    const chip = parseLine(line);
    if (!chip) continue;
    const key = chip.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(chip);
  }
  return stripCopyChips(chips);
}

// Copy-intent chips are banned: copying is a manual user action, not a chip.
// Strips any chip whose label suggests copying — even when a weak model
// ignores the prompt rule. "copywriting"/"copyright" don't match because
// \b requires a real word boundary around the verb, so "copy" glued to a
// word stays untouched.
const COPY_LABEL_RE = /\b(copy|copies|copied|copying)\b/i;

export function isCopyChipLabel(label: string): boolean {
  return COPY_LABEL_RE.test(label);
}

export function stripCopyChips(chips: SuggestionChip[]): SuggestionChip[] {
  const filtered = chips.filter((c) => !COPY_LABEL_RE.test(c.label));
  return filtered.length === chips.length ? chips : filtered;
}

// next-action block extraction

// The model appends its "next actions" chips to the end of an answer inside
// these exact tags (see the "# Next-action chips" section of SYSTEM_PROMPT).
// The block is DATA for the UI — it must never reach the visible answer.
// Weak models are sloppy: they may emit the block multiple times (mid-answer
// narration), skip the tags and write a bare `[{"label":...}]` array under a
// "Next actions:" header, or leave the array dangling at the end. The parser
// handles all of those so the row shows up and the raw JSON never leaks.
export const NEXT_ACTIONS_OPEN = '[NEXT_ACTIONS]';
export const NEXT_ACTIONS_CLOSE = '[/NEXT_ACTIONS]';

export type NextActionsParse = {
  chips: SuggestionChip[];
  cleanText: string;
};

const NEXT_ACTIONS_TAGGED = /\[NEXT_ACTIONS\][\s\S]*?\[\/NEXT_ACTIONS\]/gi;
// Same block wrapped in a code fence (weak models do this despite the prompt).
// Matches the fence lines too so nothing is left dangling after stripping.
const NEXT_ACTIONS_FENCED = /```(?:json)?\s*\n?\[NEXT_ACTIONS\][\s\S]*?\[\/NEXT_ACTIONS\]\s*\n?\s*```/gi;
// The model forgot the close tag: `[NEXT_ACTIONS]` followed by a chip array
// running to the very end of the answer.
const NEXT_ACTIONS_UNCLOSED = /\[NEXT_ACTIONS\][\s\S]*\n\s*(\[[\s\S]*?\])\s*$/i;
// "Next actions for you:" / "Next actions:" / "Next action:" at a line start.
const NEXT_ACTIONS_HEADER = /(?:^|\n)\s*next actions?\s*(?:for\s+(?:you|the user))?\s*[:：-]?\s*(?:\n|$)/i;

function blockInner(block: string): string {
  const open = block.indexOf('[NEXT_ACTIONS]');
  const close = block.lastIndexOf('[/NEXT_ACTIONS]');
  if (open === -1 || close === -1 || close <= open) return '';
  return block.slice(open + NEXT_ACTIONS_OPEN.length, close).trim();
}

// A JSON array that looks like a chip array (has a "label" field), so
// parseChipSuggestions' permissive line fallback never fires on real prose.
function looksLikeChipArray(s: string): boolean {
  return /"label"/i.test(s);
}

export function parseNextActionsFromAnswer(answer: string): NextActionsParse {
  const text = (answer ?? '').trim();
  if (!text) return { chips: [], cleanText: text };

  let working = text;
  let chips: SuggestionChip[] = [];

  const consider = (src: string): boolean => {
    if (!looksLikeChipArray(src)) return false;
    const parsed = parseChipSuggestions(src);
    if (parsed.length > 0) {
      chips = parsed;
      return true;
    }
    return false;
  };

  // 1) Tagged blocks: parse every one (keep the last that yields chips) and
  //    strip them all — including the ones a chatty model wrote mid-answer,
  //    and any that got wrapped in a code fence.
  const fencedBlocks = working.match(NEXT_ACTIONS_FENCED) ?? [];
  for (const block of fencedBlocks) consider(blockInner(block));
  if (fencedBlocks.length > 0) working = working.replace(NEXT_ACTIONS_FENCED, '');
  const taggedBlocks = working.match(NEXT_ACTIONS_TAGGED) ?? [];
  for (const block of taggedBlocks) consider(blockInner(block));
  if (taggedBlocks.length > 0) working = working.replace(NEXT_ACTIONS_TAGGED, '');

  // 1b) Unclosed block: the model forgot `[/NEXT_ACTIONS]` and left the open
  //     tag followed by a chip array at the end of the answer. Parse that
  //     array and strip from the open tag to the end.
  if (chips.length === 0) {
    const unclosed = working.match(NEXT_ACTIONS_UNCLOSED);
    if (unclosed && consider(unclosed[1])) {
      const idx = working.search(/\[NEXT_ACTIONS\]/i);
      if (idx >= 0) working = working.slice(0, idx);
    }
  }

  // 2) Header + payload: "Next actions for you:\n[{...}]".
  if (chips.length === 0) {
    const header = working.match(NEXT_ACTIONS_HEADER);
    if (header) {
      const index = header.index ?? 0;
      const after = working.slice(index + header[0].length);
      const array = after.match(/^\s*(?:```(?:json)?\s*)?(\[[\s\S]*?\])\s*(?:```)?/);
      if (array && consider(array[1])) {
        // Re-insert the line break the header consumed so the narration
        // paragraph keeps its separation from the sentence before it.
        working = working.slice(0, index) + '\n' + after.slice(array[0].length);
      }
    }
  }

  // 3) A bare chip array dangling at the very end (model skipped header/tags).
  if (chips.length === 0) {
    const m = working.match(/(?:^|\n)\s*(\[[\s\S]*?\])\s*$/);
    if (m && consider(m[1])) {
      working = working.slice(0, m.index ?? 0);
    }
  }

  // 4) Chips found: purge any leftover standalone chip-array junk lines that
  //    the model narrated mid-answer, so no raw JSON reaches the user.
  if (chips.length > 0) {
    working = working.replace(/(?:^|\n)\s*\[\s*\{\s*"label"[\s\S]*?\}\s*\]\s*(?=\n|$)/g, '\n');
  }

  // 5) Purge any leftover `[NEXT_ACTIONS]` / `[/NEXT_ACTIONS]` tag lines the
  //    model wrote outside a complete block — tags are UI markers, never text.
  working = working
    .replace(/(?:^|\n)\s*\[NEXT_ACTIONS\]\s*(?=\n|$)/gi, '\n')
    .replace(/(?:^|\n)\s*\[\/NEXT_ACTIONS\]\s*(?=\n|$)/gi, '\n');

  const cleanText = working
    .replace(/(?:```(?:json)?|```)\s*$/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { chips, cleanText };
}

// reply-payload extraction

// The model is instructed (see prompt.ts and the reply-chip prompts) to put
// ONLY the answer it wants displayed between [REPLY] and [/REPLY] tags.
// Anything before or after the tags — reasoning, narration, commentary — is
// discarded. This is a contract, not a heuristic: if no tags are present the
// text is returned untouched (never guess, never strip).
export const REPLY_OPEN = '[REPLY]';
export const REPLY_CLOSE = '[/REPLY]';

const REPLY_TAG_RE = /\[REPLY\]|\[\/REPLY\]/i;
// Complete tagged block (lazy so a second block that appears later doesn't
// swallow the first), the same block wrapped in a code fence, and the
// unclosed variant where the model forgot [/REPLY] and ran to the end.
const REPLY_TAGGED = /\[REPLY\][\s\S]*?\[\/REPLY\]/i;
const REPLY_TAGGED_G = /\[REPLY\][\s\S]*?\[\/REPLY\]/gi;
const REPLY_FENCED = /```(?:text)?\s*\n?\[REPLY\][\s\S]*?\[\/REPLY\]\s*\n?\s*```/i;
const REPLY_UNCLOSED = /\[REPLY\]([\s\S]*)$/i;

function replyBlockInner(block: string): string {
  const open = block.indexOf(REPLY_OPEN);
  const close = block.lastIndexOf(REPLY_CLOSE);
  if (open === -1 || close === -1 || close <= open) return '';
  return block.slice(open + REPLY_OPEN.length, close).trim();
}

// Returns ONLY the payload between the [REPLY] tags. When the tags are
// missing entirely, or every block is empty / still contains tags (the model
// emitted [REPLY]\n[REPLY]\n[/REPLY]), the input is returned unchanged —
// this function never guesses at what "should" be kept.
export function stripReplyPayload(answer: string): string {
  const text = (answer ?? '').trim();
  if (!text) return text;

  const usable = (inner: string): string | null => {
    if (!inner || REPLY_TAG_RE.test(inner)) return null;
    return inner;
  };

  const blocks = text.match(REPLY_TAGGED_G) ?? [];
  for (const block of blocks) {
    const inner = usable(replyBlockInner(block));
    if (inner) return inner;
  }

  const fenced = text.match(REPLY_FENCED);
  if (fenced) {
    const inner = usable(replyBlockInner(fenced[0]));
    if (inner) return inner;
  }

  const unclosed = text.match(REPLY_UNCLOSED);
  if (unclosed) {
    const inner = usable(unclosed[1].trim());
    if (inner) return inner;
  }

  return text;
}

// smart cache helpers

// Normalize raw screen/app context into a stable cache key. Collapses
// whitespace and drops blank lines so OCR noise and volatile empty url/tab
// entries don't bust the exact-hash hit.
export function normalizeChipContext(ctx: string): string {
  return ctx
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// Bounded Levenshtein: returns -1 once every path exceeds `maxDist` (early
// exit keeps near-identical short strings cheap).
function boundedLevenshtein(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return -1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return -1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// 0..1 similarity for the fuzzy chip-cache reuse. Allows up to ~15% edit
// distance (OCR jitter, tiny app-tab changes); identical text is 1.
export function textSimilarity(a: string, b: string): number {
  const sa = a.trim();
  const sb = b.trim();
  if (sa === sb) return 1;
  const len = Math.max(sa.length, sb.length);
  if (len === 0) return 1;
  const bound = Math.max(4, Math.ceil(len * 0.15));
  const d = boundedLevenshtein(sa, sb, bound);
  if (d < 0) return 0;
  return 1 - d / len;
}

// "Suggest a reply" / any reply/respond chip must ONLY surface when a real
// chat/email conversation is on screen. When the pointed-at app isn't a
// conversation (a terminal, an explorer window, a shell flyout…), reply
// chips are stripped out — including any the chip model hallucinated — so
// the row can never offer to reply to a message that isn't visible.
const REPLY_LABEL_RE = /\b(reply|respond)\b/i;

export function isReplyChipLabel(label: string): boolean {
  return REPLY_LABEL_RE.test(label);
}

// Crafted hidden prompt for the "Suggest a reply" chip. Instructs the model to
// wrap ONLY the displayable reply in [REPLY] tags; everything outside the
// tags is discarded by stripReplyPayload, so the model may reason freely
// before the tag without the reasoning leaking into the UI.
export const REPLY_CHIP_PROMPT =
  'Reply to the visible conversation as the user would. ' +
  'Put ONLY the reply you want displayed between [REPLY] and [/REPLY], one tag on its own line. ' +
  'Everything outside the tags is discarded.';

// The tapped chip's own label IS the user's instruction ("Reply in Hindi",
// "Make it more formal", "Shorter", "Rephrase"). Carry it verbatim into the
// hidden prompt so the request reaches the model instead of being lost when
// the crafted reply contract replaces the chip's prompt. Nothing is matched
// or rewritten — whatever label the chip carries is appended as-is.
export function replyChipPromptFor(label: string): string {
  return `${REPLY_CHIP_PROMPT}\n${label}`;
}

// Deterministic guarantee: when a conversation (chat/email) is on screen, the
// "Suggest a reply" chip must appear even if the chip model forgot to emit it.
// When NO conversation is detected, reply/respond chips are removed outright.
// An existing reply chip keeps the crafted reply contract plus its own label
// instruction; the injected default chip carries just the contract.
export function withReplyChip(
  chips: SuggestionChip[],
  conversation: 'email' | 'chat' | null,
): SuggestionChip[] {
  if (!conversation) {
    const filtered = chips.filter((c) => !REPLY_LABEL_RE.test(c.label));
    return filtered.length === chips.length ? chips : filtered;
  }
  const alreadyReply = chips.some((c) => REPLY_LABEL_RE.test(c.label));
  if (alreadyReply) {
    return chips.map((c) => (isReplyChipLabel(c.label) ? { ...c, prompt: replyChipPromptFor(c.label) } : c));
  }
  return [{ label: 'Suggest a reply', icon: 'mail', prompt: REPLY_CHIP_PROMPT }, ...chips].slice(0, MAX_CHIPS);
}

// app-log noise scrubbing

// The chip model reads OCR of the region under the cursor and any on-screen
// text selection. When the user's terminal is showing Spirit's OWN debug log
// (the app runs from that console), that log text gets captured as "screen
// context" — and the model then echoes its own previous raw outputs instead of
// suggesting new actions, so every round degenerates to a single "Summarize
// context" chip. Strip the app's diagnostic lines out of the OCR/selection
// text BEFORE it reaches the chip prompt. Lines are dropped individually, so a
// wrapped continuation fragment whose start line was already removed is caught
// by the same signatures. Deliberately NOT applied to appContextTextFrom —
// that block is added fresh by the caller and must stay.

const APP_LOG_TAG_RE =
  /^\[\s*(main|chips|app-context|forward-click|overlay|spirit|handlers|selection|clipboard|screen|tts|local-stt|settings|web-images|agentic|router|openrouter|query|run|ocr|session|gdi|xwin)\s*\]/i;

// Signatures that only appear in the app's own console output (a `[chips]`
// payload, an app-context dump, a forwarded click). `raw=[`/`raw={` catch the
// model's raw JSON echoed into the console; `.gguf` catches the model filename.
const APP_LOG_SIG_RE =
  /(url-walk|chainFp=|sessionCtx=|\.gguf\b|raw=\[|raw=\{|\bgot display=|synthesizing (left|right) click|ai-mode (start|end)|source=(generated|cache)|CONTEXT AS OF)/i;

// A line of chip-JSON payload (`"label": "…", "icon": "…", "prompt": "…"`)
// — the raw model output echoed by the [chips] logger. Needs two of the three
// fields so a single stray `"label":` in legit text is never touched.
const CHIP_JSON_LINE_RE = /"(label|icon|prompt)"\s*:/g;

export function stripAppLogNoise(text: string): string {
  return (text ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      if (APP_LOG_TAG_RE.test(line)) return false;
      if (APP_LOG_SIG_RE.test(line)) return false;
      const matches = line.match(CHIP_JSON_LINE_RE);
      return !(matches && matches.length >= 2);
    })
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
