// Claimed-action critic — the Spirit port of GenOffice's `verifyResponse`
// (agent-core skill verifier + the sheets `response-verify.ts` pattern).
//
// The honesty gate in router.ts forces an action when the USER'S goal names
// one. This critic targets a different lie: the final ANSWER itself asserts a
// screen action ("I clicked Save", "typed my name", "downloaded it") when no
// such tool actually succeeded this run. A long answer (90+ chars) already
// bypasses the honesty gate — this is the net that catches those.
//
// Design rules (conservative on purpose — a false positive clobbers a good
// answer with a bogus correction):
//   - Only PAST-TENSE, first-person-asserted claims count. Plans, questions
//     and instructions ("I will click", "once clicked the menu opens") never do.
//   - Mouse done-verbs (clicked/opened/saved/downloaded/selected/...) can be
//     legitimately satisfied by ANY successful mutating tool (a "save" often
//     IS a ui_click on the Save button, a "download" IS a click), so they only
//     fire when NO mutating action ran at all. "made"/"built" are treated the
//     same — a click that builds something is a real action.
//   - Keyboard/clipboard verbs (typed / pasted / copied) are precise: a mouse
//     click can never type or copy, so they fire when their specific tool did
//     not run — even if some other action happened.
//   - File verbs (created / generated / wrote) are precise too: writing a real
//     file needs create_file, save_document or run_command — a click never
//     makes a file, so an unsupported claim fires even when other actions ran.
//
// Pure module (no Electron, no provider) so vitest can drive it directly.

// Completed-action verbs split by how they can be satisfied.
const MOUSE_DONE_VERBS = new Set([
  'clicked', 'tapped', 'pressed', 'selected',
  'opened', 'launched', 'saved', 'downloaded',
  'submitted', 'double-clicked', 'made', 'built',
]);

// Verbs that can NEVER be satisfied by a mouse action — they need their exact
// tool (or a paste that types). Firing on these is precision-safe even when the
// run did perform other actions.
const STRICT_CLAIM_TOOLS: Record<string, string[]> = {
  typed: ['type_text', 'paste_table', 'paste_image'],
  pasted: ['paste_table', 'paste_image', 'type_text'],
  copied: ['copy_to_clipboard'],
  // File-creation claims can't be satisfied by a click — the file must have
  // actually been written by one of the writing tools.
  created: ['create_file', 'save_document', 'run_command'],
  generated: ['create_file', 'save_document', 'run_command'],
  wrote: ['create_file', 'save_document', 'run_command', 'type_text'],
};

// Negation or softened language right before/at the claim means "did NOT do"
// or "would NOT do" — never count it as a completion claim.
const NEGATION_RE =
  /\b(?:didn'?t|did not|never|not|won'?t|can'?t|couldn'?t|don'?t|wouldn'?t|shouldn'?t|would not|without|no longer)\b/i;

// Future/conditional/instruction markers: "I will click", "you can click",
// "once clicked", "if clicked", "to click" — a plan, not a completed claim.
const NON_COMPLETION_RE =
  /\b(?:will|going to|would|could|should|can|may|might|need to|wants to|want to|to click|to type|to press|when clicked|once clicked|if clicked|after clicking|by clicking|like to|prefer)/i;

const ACTION_VERB_ORDER = [
  'double-clicked',
  'downloaded',
  'submitted',
  'selected',
  'launched',
  'clicked',
  'pressed',
  'typed',
  'pasted',
  'copied',
  'tapped',
  'opened',
  'saved',
  'created',
  'generated',
  'wrote',
  'made',
  'built',
  'sent',
];

// Split into clauses (sentences, explicit list items, comma-bound units) so the
// claim check evaluates local context instead of the whole blob.
function clauseFragments(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  return t
    .split(/[.!?]\s+|\n+|\n?[-*]\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Canonicalized verbs that this answer claims as completed past actions.
export function extractActionClaims(text: string): string[] {
  const lower = (text ?? '').toLowerCase().replace(/\s+/g, ' ');
  const found = new Set<string>();
  for (const clause of clauseFragments(lower)) {
    // Claim must be phrased as an assertion: first-person ("i clicked …",
    // "i've clicked …", "already clicked") or a bare past-tense statement
    // ("Clicked the Download button."). Instructions/questions never match.
    const isAssertion =
      /^(?:i(?:'ve| have)?|already)\s+/.test(clause) ||
      new RegExp(
        `^(?:${ACTION_VERB_ORDER.map((v) => v.replace('-', '\\-')).join('|')})\\b`,
      ).test(clause);
    if (!isAssertion) continue;
    if (NEGATION_RE.test(clause)) continue;
    if (NON_COMPLETION_RE.test(clause)) continue;
    for (const verb of ACTION_VERB_ORDER) {
      const re = new RegExp(`\\b${verb.replace('-', '\\-')}\\b`);
      if (re.test(clause)) found.add(verb);
    }
  }
  return [...found];
}

export type ClaimContext = {
  // Tool names that executed successfully this run (from the router's `done`
  // bookkeeping, plus direct-routed goal actions).
  executedTools: ReadonlySet<string>;
  // Did any mutating (non-read-only) action succeed this run? Covers
  // router-driven goal clicks, which succeed without a `done` entry.
  hasMutatingAction: boolean;
};

// Returns a corrective instruction when the answer claims an action the run
// cannot back up, else null. Exactly GenOffice's `verifyResponse` contract.
export function verifyActionClaims(
  answer: string,
  ctx: ClaimContext,
): string | null {
  const claims = extractActionClaims(answer);
  if (claims.length === 0) return null;

  const unsupported: string[] = [];
  for (const verb of claims) {
    const strict = STRICT_CLAIM_TOOLS[verb];
    if (strict) {
      if (!strict.some((t) => ctx.executedTools.has(t))) unsupported.push(verb);
    } else if (MOUSE_DONE_VERBS.has(verb) && !ctx.hasMutatingAction) {
      unsupported.push(verb);
    }
  }
  if (unsupported.length === 0) return null;

  const strictOnly = unsupported.every((v) => STRICT_CLAIM_TOOLS[v]);
  const what = strictOnly
    ? unsupported.join('/')
    : unsupported.join('/');
  const tools = unsupported
    .flatMap((v) => STRICT_CLAIM_TOOLS[v] ?? [])
    .filter((t, i, a) => a.indexOf(t) === i);

  return (
    `CLAIMED-ACTION CHECK: your reply claims you "${what}" on screen, but no tool that can ` +
    `${strictOnly ? 'perform that action' : 'perform any screen action'} succeeded this run` +
    (tools.length > 0 ? ` (expected a successful ${tools.join(' / ')})` : '') +
    `. Never claim a screen action you did not actually perform. ` +
    `Either call the right tool NOW (see_screen()/ui_read() first if you need to look), ` +
    `or rewrite the answer to describe honestly what really happened.`
  );
}