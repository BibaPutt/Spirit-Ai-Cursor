// Word-level helpers for the TTS reading view: split the spoken (cleaned)
// text into tokens, map a speech char offset to a word index, and align Edge
// TTS word-boundary metadata (absolute audio timestamps) to those tokens so
// the currently-spoken word can be highlighted and clicked-to-seek.
// Pure module — no React, no ipc — so it unit-tests directly.

export type WordToken = { text: string; start: number };

// Split text into non-whitespace tokens, keeping each token's char offset so
// Web Speech boundary charIndex values can be mapped back to a word.
export function splitWords(text: string): WordToken[] {
  const words: WordToken[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    words.push({ text: m[0], start: m.index });
  }
  return words;
}

// Index of the word containing the given char offset (the last word whose
// start is <= charIndex). Returns -1 when there are no words.
export function wordIndexAtChar(words: WordToken[], charIndex: number): number {
  if (words.length === 0) return -1;
  let idx = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= charIndex) idx = i;
    else break;
  }
  return idx;
}

export type Boundary = { text: string; offsetMs: number; durationMs: number };
export type WordTime = { startMs: number; endMs: number } | null;

function normWord(s: string): string {
  return s.replace(/[.,;:!?…"“”‘’()[\]{}«»]+$/, '').toLowerCase();
}

// Align boundary metadata to tokens. Edge reports one boundary per spoken
// word; the reported text usually matches the token once trailing punctuation
// is stripped, but can differ (numbers, contractions), so we match greedily.
// Tokens without a direct hit reuse the previous word's end time so the
// highlight keeps moving instead of stalling.
export function alignBoundaries(words: WordToken[], boundaries: Boundary[]): WordTime[] {
  const times: WordTime[] = words.map(() => null);
  if (boundaries.length === 0) return times;
  let j = 0;
  for (let i = 0; i < words.length; i++) {
    const nw = normWord(words[i].text);
    if (!nw) continue;
    // Scan forward from the last matched boundary. j only advances on an
    // actual match — an unmatched token must not skip past a boundary that a
    // later token could still hit.
    for (let k = j; k < boundaries.length; k++) {
      const b = boundaries[k];
      const nb = normWord(b.text.trim());
      if (!nb) continue;
      const shorter = nb.length < nw.length ? nb : nw;
      const longer = nb.length < nw.length ? nw : nb;
      if (nb === nw || (longer.startsWith(shorter) && longer.length - shorter.length <= 2)) {
        times[i] = { startMs: b.offsetMs, endMs: b.offsetMs + b.durationMs };
        j = k + 1;
        break;
      }
    }
  }
  let prev: WordTime = null;
  for (let i = 0; i < words.length; i++) {
    if (times[i]) {
      prev = times[i];
    } else if (prev) {
      times[i] = { startMs: prev.endMs, endMs: prev.endMs + 120 };
      prev = times[i];
    }
  }
  return times;
}
