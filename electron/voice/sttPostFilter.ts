// Post-filter for final voice transcripts (never live text).
// Pure module — unit-tested, imported by electron/voice/transcribe.ts which
// owns the user's settings. Three passes:
//   1. spoken punctuation ("comma" -> ",") — English + Hindi/Hinglish forms;
//   2. filler-word drop (uh/um/hmm…);
//   3. personal word overrides, one "a -> b" per line from Settings → Voice.
export function parseWordOverrides(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.split(/->|=>|=/);
    if (m.length < 2) continue;
    const from = m[0].trim();
    const to = m.slice(1).join(' ').trim();
    if (from && to && out.length < 200) out.push([from, to]);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Spoken punctuation, longest match first. Hindi forms included
// (purn viraam, prashn chinh, alpaviram) for Hindi/Hinglish speakers.
const SPOKEN_PUNCT: Array<[RegExp, string]> = [
  [/\b(full stop|purn[ae]? ?viram|purna viram)\b/gi, '.'],
  [/\b(question mark|prashn[ae]? ?chinh|prashna chinh)\b/gi, '?'],
  [/\b(exclamation( mark| point)?)\b/gi, '!'],
  [/\b(new line|newline|nayi line)\b/gi, '\n'],
  [/\b(semi[ -]?colon)\b/gi, ';'],
  [/\b(colon)\b/gi, ':'],
  [/\b(comma|alpaviram|alpa viram)\b/gi, ','],
];

const FILLER_RE = /(^|[\s(\["'])(uh+|um+|hmm+|erm+|ah+|eh+|ooh+)(?=[\s,.:;?!)\]"']|$)/gi;

export function applySttPostFilter(text: string, overridesRaw: string): string {
  let out = text;
  for (const [re, to] of SPOKEN_PUNCT) out = out.replace(re, to);
  out = out.replace(FILLER_RE, '$1');
  for (const [from, to] of parseWordOverrides(overridesRaw)) {
    out = out.replace(new RegExp(escapeRegExp(from), 'gi'), to);
  }
  // "word comma" -> "word," (no space before punctuation).
  out = out.replace(/ +([,.?!;:])/g, '$1');
  out = out.replace(/[ \t]*\n[ \t]*/g, '\n');
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
