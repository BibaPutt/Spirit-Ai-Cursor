// Boundary-aware stitching of windowed voice transcription (Phase 7).
//
// Live STT slices audio into non-overlapping ~1.5s windows, and each window's
// transcript is independent. Whisper rarely cuts exactly on a word boundary, so
// a word spanning a slice edge shows up twice — once truncated at the end of
// the previous transcript ("ple"), once whole at the start of the next
// ("please"). Naive concatenation therefore produces stuttery, error-stuffed
// text.
//
// mergeTranscript stitches two consecutive windowed transcripts:
//   - matched overlap: when the tail of `prev` equals the head of `next`
//     (the same complete word(s) in both), keep prev and drop the duplicate.
//   - split word: when prev's last word is a prefix of next's first word (or
//     vice versa), keep the longer copy and drop the truncated one.
//   - otherwise append with a single space.
// The merge is conservative: it only ever removes near-certain duplicates,
// never invented overlap.

const OVERLAP_MAX_WORDS = 6;

function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

// Stitch `next` after `prev`, deduping a cut word or repeated tail/head.
export function mergeTranscript(prev: string, next: string): string {
  const prevClean = prev.trim();
  const nextClean = next.trim();
  if (!nextClean) return prevClean;
  if (!prevClean) return nextClean;

  const prevWords = wordsOf(prevClean);
  const nextWords = wordsOf(nextClean);

  // Whole-word overlap first: the longest shared tail(prev)/head(next).
  const maxOverlap = Math.min(OVERLAP_MAX_WORDS, prevWords.length, nextWords.length);
  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    const prevTail = prevWords.slice(-overlap).join(' ').toLowerCase();
    const nextHead = nextWords.slice(0, overlap).join(' ').toLowerCase();
    if (prevTail === nextHead) {
      const rest = nextWords.slice(overlap).join(' ');
      return wrapJoin(prevWords, rest);
    }
  }

  // Not an exact word match — check for a word split across the boundary. The
  // cut usually truncates a word in prev ("hel") and completes it in next
  // ("hello"), or voices a boundary artifact in prev that next starts fresh.
  const prevLast = prevWords[prevWords.length - 1].toLowerCase();
  const nextFirst = nextWords[0].toLowerCase();
  const prefixLen = commonPrefixLen(prevLast, nextFirst);
  if (prefixLen > 0 && (prevLast.length === prefixLen || nextFirst.length === prefixLen)) {
    if (prevLast.length >= nextFirst.length) {
      // prev ends with the longer/completed form, next echoes a truncated copy
      // of it — drop next's first word.
      const rest = nextWords.slice(1).join(' ');
      return wrapJoin(prevWords, rest);
    }
    // next completes prev's cut-off word — drop prev's truncated last word.
    return wrapJoin(prevWords.slice(0, -1), nextWords.join(' '));
  }

  return `${prevClean} ${nextClean}`;
}

function wrapJoin(words: string[], rest: string): string {
  const base = words.join(' ');
  if (!rest) return base;
  return `${base} ${rest}`;
}

// Fold a sequence of chunk transcripts (from a single recording session) into
// one clean text, preserving order. Used by the final merge on stop.
export function mergeTranscripts(parts: readonly string[]): string {
  let acc = '';
  for (const part of parts) {
    acc = mergeTranscript(acc, part);
  }
  return acc;
}