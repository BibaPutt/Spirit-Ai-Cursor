// Fuzzy search across the documentation (developer docs, legal docs, the
// manual). Dependency-free fzf-lite: every query token must subsequence-
// match somewhere in the entry's haystack, scored by consecutiveness and
// word-start bonuses. Titles weigh 3×, the plain-language intro 2×, the
// body 1×.

export type DocSearchEntry = {
  /** Section anchor inside the page, e.g. 'tools' */
  sectionId: string;
  /** Page route, e.g. '/dev-docs.html' */
  pageUrl: string;
  /** Display label of the page, e.g. 'Developer Docs' */
  pageLabel: string;
  title: string;
  text: string;
};

export type DocSearchHit = DocSearchEntry & {
  score: number;
  snippet: string;
};

const TITLE_WEIGHT = 3;
const MAX_HITS = 8;

function fuzzyToken(token: string, target: string): number {
  // Best subsequence score of `token` inside `target`; -1 when absent.
  let best = -1;
  const starts: number[] = [];
  let inWord = false;
  for (let i = 0; i < target.length; i++) {
    const ch = target[i];
    const isWord = /[a-z0-9]/.test(ch);
    if (isWord && !inWord) starts.push(i);
    inWord = isWord;
  }
  for (const s of starts) {
    let score = 0;
    let ti = s;
    let streak = 0;
    let ok = true;
    for (let k = 0; k < token.length; k++) {
      const idx = target.indexOf(token[k], ti);
      if (idx === -1) {
        ok = false;
        break;
      }
      if (idx === ti && k > 0) score += 3 + streak * 2; // consecutive
      if (starts.includes(idx)) score += 6; // word start
      else if (k === 0) score += 2;
      score += 1;
      streak = idx === ti ? streak + 1 : 0;
      ti = idx + 1;
    }
    // Early-exit penalty: matches that begin later rank lower.
    if (ok) best = Math.max(best, score - Math.floor(s / 24));
  }
  return best;
}

function snippetAround(text: string, query: string): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  const first = query.trim().split(/\s+/)[0] ?? '';
  if (!first) return plain.slice(0, 120);
  const at = plain.toLowerCase().indexOf(first.toLowerCase());
  if (at === -1) return plain.slice(0, 120);
  const from = Math.max(0, at - 40);
  return (from > 0 ? '…' : '') + plain.slice(from, from + 130) + (from + 130 < plain.length ? '…' : '');
}

export function searchDocs(entries: DocSearchEntry[], query: string): DocSearchHit[] {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];
  const tokens = q.split(/\s+/).slice(0, 6);
  const hits: DocSearchHit[] = [];

  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    let score = 0;
    let all = true;

    for (const token of tokens) {
      const inTitle = fuzzyToken(token, title);
      const inText = fuzzyToken(token, entry.text.toLowerCase());
      if (inTitle < 0 && inText < 0) {
        all = false;
        break;
      }
      score += Math.max(inTitle * TITLE_WEIGHT, inText);
      if (inTitle >= 0) score += inTitle * TITLE_WEIGHT * 0.5;
    }

    if (!all) continue;

    // Exact phrase bonus.
    if (entry.title.toLowerCase().includes(q) || entry.text.toLowerCase().includes(q)) {
      score += 14;
    }

    hits.push({ ...entry, score, snippet: snippetAround(entry.text, q) });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
}
