// Shared deterministic text utilities for BM25 lemmatization, synonym
// expansion, and fuzzy n-gram matching. Zero dependencies — used by the
// context-memory recall and the screen/topic relevance gates so both see
// identical tokenization and the same built-in synonym vocabulary.
//
// The lemmatizer is the simpleStem fallback ported from mem0 (Apache-2.0)
// utils/lemmatization.ts; the synonym families and n-gram fuzzy matcher are
// Spirit's own low-dependency stand-in for embeddings.

const STOP_WORDS: Set<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', "aren't", 'as', 'at', 'be', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'by', 'can', "can't", 'cannot',
  'could', "couldn't", 'did', "didn't", 'do', 'does', "doesn't", 'doing',
  "don't", 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'get',
  'got', 'had', "hadn't", 'has', "hasn't", 'have', "haven't", 'having', 'he',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', "isn't", 'it', "it's", 'its', 'itself', 'just', "let's",
  'me', 'might', 'more', 'most', "mustn't", 'must', 'my', 'myself', 'no',
  'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shall', "shan't",
  'she', 'should', "shouldn't", 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very',
  'was', "wasn't", 'we', 'were', "weren't", 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', "won't", 'would', "wouldn't",
  'you', 'your', 'yours', 'yourself', 'yourselves', 'user', 'users',
]);

function simpleStem(word: string): string {
  if (word.length <= 3) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) {
    w = w.slice(0, -3) + 'i';
  } else if (w.endsWith('sses')) {
    w = w.slice(0, -2);
  } else if (w.endsWith('ness')) {
    w = w.slice(0, -4);
  } else if (w.endsWith('ment') && w.length > 5) {
    w = w.slice(0, -4);
  } else if (w.endsWith('ation') && w.length > 6) {
    w = w.slice(0, -5) + 'e';
  } else if (w.endsWith('ting') && w.length > 5) {
    w = w.slice(0, -3);
  } else if (w.endsWith('ing') && w.length > 5) {
    w = w.slice(0, -3);
  } else if (w.endsWith('ed') && w.length > 4) {
    w = w.slice(0, -2);
  } else if (w.endsWith('ly') && w.length > 4) {
    w = w.slice(0, -2);
  } else if (w.endsWith('er') && w.length > 4) {
    w = w.slice(0, -2);
  } else if (w.endsWith('est') && w.length > 4) {
    w = w.slice(0, -3);
  } else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) {
    w = w.slice(0, -1);
  }
  return w;
}

export function lemmatizeForBm25(text: string): string {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g);
  if (!words) return lower;
  const tokens: string[] = [];
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    const stemmed = simpleStem(word);
    if (stemmed && /^[a-z0-9]+$/.test(stemmed)) tokens.push(stemmed);
    if (word.endsWith('ing') && word !== stemmed && /^[a-z0-9]+$/.test(word)) {
      tokens.push(word);
    }
  }
  return tokens.join(' ');
}

// Significant (stop-word-free, stemmed) tokens of a text, in order.
export function tokenizeSignificant(text: string): string[] {
  return lemmatizeForBm25(text).split(' ').filter(Boolean);
}

// Synonym expansion — a small built-in vocabulary that lets "precipitation"
// recall a memory about "rain" without any embedding model. Each family is a
// set of equivalent terms; expansion maps any member to the whole family.

const SYNONYM_FAMILIES: ReadonlyArray<ReadonlyArray<string>> = [
  ['rain', 'precipitation', 'rainfall', 'downpour', 'drizzle'],
  ['cow', 'cattle', 'bull', 'calf', 'livestock'],
  ['car', 'automobile', 'vehicle', 'truck', 'motor'],
  ['photo', 'picture', 'image', 'pic'],
  ['purchase', 'buy', 'bought', 'purchased'],
  ['app', 'application', 'program', 'software'],
  ['doctor', 'physician'],
  ['fridge', 'refrigerator', 'frige'],
  ['television', 'tv'],
  ['phone', 'cellphone', 'smartphone', 'mobile'],
  ['job', 'work', 'career', 'profession'],
  ['home', 'house', 'apartment'],
  ['buy', 'shop', 'shopping', 'store'],
  ['restaurant', 'cafe', 'café', 'eatery'],
  ['dog', 'puppy', 'canine'],
  ['cat', 'kitten', 'feline'],
  ['school', 'college', 'university', 'campus'],
  ['money', 'budget', 'cash', 'funds'],
  ['speech', 'talk', 'presentation'],
  ['start', 'begin', 'commence'],
  ['stop', 'end', 'finish', 'halt'],
  ['build', 'make', 'create', 'develop'],
  ['help', 'assist', 'support'],
  ['big', 'large', 'huge', 'enormous'],
  ['small', 'little', 'tiny'],
  ['fast', 'quick', 'rapid', 'swift'],
  ['slow', 'gradual'],
  ['happy', 'glad', 'pleased'],
  ['sad', 'unhappy', 'upset'],
  ['difficult', 'hard', 'tough', 'challenging'],
  ['easy', 'simple', 'straightforward'],
  ['important', 'crucial', 'essential', 'vital', 'key'],
  ['interesting', 'fascinating', 'intriguing'],
  ['answer', 'reply', 'response'],
  ['question', 'query', 'ask'],
  ['browser', 'chrome', 'firefox', 'safari', 'edge'],
  ['spreadsheet', 'excel', 'sheets'],
  ['document', 'doc', 'file', 'paper'],
  ['email', 'mail', 'gmail', 'outlook'],
  ['weather', 'forecast', 'climate'],
  ['price', 'cost', 'charge', 'fee'],
];

// Both the query and the stored memories pass through the same stemmer before
// expansion, so the map is keyed by STEMMED terms ("precipitation" -> "precipite"
// after the simple stemmer). Each family member is stemmed once at build time
// so expansion always emits the same form the tokenizer would produce.
const SYNONYM_MAP: Map<string, string[]> = new Map();
for (const family of SYNONYM_FAMILIES) {
  const stemmed = Array.from(new Set(family.map(simpleStem)));
  for (const member of stemmed) {
    SYNONYM_MAP.set(member, stemmed.slice());
  }
}

// Expand a list of (stemmed) tokens to include every synonym-family sibling.
// Order is stable: each input token contributes its family's members in the
// family's declared order, deduplicated globally.
export function expandSynonyms(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const family = SYNONYM_MAP.get(t);
    if (family) {
      for (const member of family) {
        if (!out.includes(member)) out.push(member);
      }
    } else if (!out.includes(t)) {
      out.push(t);
    }
  }
  return out;
}

// Fuzzy n-gram matching — catches morphological drift that the simple stemmer
// misses (e.g. "automation" ~ "automatization"). Returns the number of tokens
// in `a` that fuzzy-match at least one token in `b`.

// Bigram-only overlap: adding trigrams dilutes the ratio (a near-identical
// pair like "definately"/"definitely" drops from 0.64 to 0.55 and misses),
// while bigrams alone keep the signal sharp. Combined with the first-character
// requirement and the 0.6 threshold this only fires on genuine typos/inflected
// twins, and the recall score floor damps any residual false positive.
function charNGrams(token: string, sizes: number[] = [2]): Set<string> {
  const set = new Set<string>();
  const clean = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const n of sizes) {
    if (clean.length < n) continue;
    for (let i = 0; i <= clean.length - n; i++) {
      set.add(clean.slice(i, i + n));
    }
  }
  return set;
}

export function fuzzyTokenOverlap(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  let matches = 0;
  for (const a of tokensA) {
    if (a.length < 4) continue;
    const gramsA = charNGrams(a);
    if (gramsA.size < 2) continue;
    let hit = false;
    for (const b of tokensB) {
      if (b.length < 4 || Math.abs(a.length - b.length) > 2) continue;
      // Same first character required: otherwise "train"~"brain" and
      // "plant"~"plane" (bigram-overlap 0.6) would false-positive.
      if (b[0] !== a[0]) continue;
      const gramsB = charNGrams(b);
      let shared = 0;
      for (const g of gramsA) if (gramsB.has(g)) shared++;
      const union = gramsA.size + gramsB.size - shared;
      if (union > 0 && shared / union >= 0.6) {
        hit = true;
        break;
      }
    }
    if (hit) matches++;
  }
  return matches;
}
