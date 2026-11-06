// Split a long user prompt into separate sub-tasks so each one can run its
// own bounded agentic loop ("1. open excel 2. make a table 3. paste it" →
// ["open excel", "make a table", "paste it"]).
//
// Splitting is FORMAT-DRIVEN and nothing else: only explicitly numbered
// ("1. 2. 3.") or bulleted ("- ") task lists split. Natural language is one
// goal — the agent loop already executes every step across bounded rounds —
// so word heuristics ("split on 'and', 'then' or a comma") are not needed and
// only shred single questions like "what is the difference between X and Y"
// into fake sub-tasks. Quote/paren-aware, so separators inside quoted strings
// ("save as notes, draft") never split a task.

const MASK = '\u0001';

function restoreMasked(piece: string, protected_: string[]): string {
  return piece.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => protected_[Number(i)] ?? '');
}

// The [REPLY] contract marker (see REPLY_CHIP_PROMPT) marks a deterministic
// single deliverable — never split it, even if the goal contains list-looking
// text.
const REPLY_TAG_RE = /\[REPLY\]|\[\/REPLY\]/i;

export function splitGoal(goal: string): string[] {
  const text = goal.trim();
  if (!text) return [];
  if (REPLY_TAG_RE.test(text)) return [goal];

  // Protect quoted strings and parenthesized groups so separators inside
  // them never split ("save as notes, draft" stays one item).
  const protected_: string[] = [];
  const protectRe = /"[^"]*"|'[^']*'|`[^`]*`|\([^()]*\)/g;
  const masked = text.replace(protectRe, (m) => {
    protected_.push(m);
    return `${MASK}${protected_.length - 1}${MASK}`;
  });

  const restore = (pieces: string[]): string[] =>
    pieces.map((p) => restoreMasked(p, protected_));

  // Numbered list: "1. open excel  2. make a table" or "1) x  2) y".
  if (/(?:^|\s)\d+[.)]\s+/.test(masked)) {
    const pieces = masked
      .split(/(?:^|\s)\d+[.)]\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3);
    if (pieces.length >= 2) return restore(pieces);
  }

  // Bulleted list: "- open excel\n- paste a table".
  const bullets = masked.match(/(?:^|\n)\s*[-•*]\s+/g) ?? [];
  if (bullets.length >= 2) {
    const pieces = masked
      .split(/(?:^|\n)\s*[-•*]\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3);
    if (pieces.length >= 2) return restore(pieces);
  }

  return [goal];
}
