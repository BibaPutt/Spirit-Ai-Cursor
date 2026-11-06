// Pure parsing for the model-emitted [IMAGE] subject lines — the image
// analogue of [NEXT_ACTIONS]. The answering model writes a plain subject
// (never a URL) on its own line:
//
//   [IMAGE] Eiffel Tower at night with lights
//
// main strips the line from the answer and searches the real backends for
// each subject. A subject is just a search query, so the model can never
// fabricate links. Never touches Electron, so vitest exercises it directly.
//
// The line format is STRICT about POSITION: the ENTIRE line must be a picture
// tag — `[IMAGE] <subject>` at line start (optionally bulleted, case does not
// matter). Prose like "the images: cow", a mid-sentence "[IMAGE] cow", a
// plural "[IMAGES] cow", or a bare "[IMAGE]" with no subject can never match.

export const IMAGE_TOKEN = '[IMAGE]';

export type ImageRequestParse = {
  // Up to MAX_IMAGE_QUERIES subjects, in answer order.
  subjects: string[];
  // The answer with every [IMAGE] line (and any fence that wraps them)
  // removed.
  cleanText: string;
};

export const MAX_IMAGE_QUERIES = 3;

// Whole line must be a picture tag: `[IMAGE] <subject>` (case-insensitive) or
// a bulleted `- [image] <subject>`. `m` so it applies to every line; `[^\n]`
// keeps a subject on one line. A line that STARTS with the bracket tag and is
// otherwise just the subject is unmistakably the model obeying the contract —
// prose never opens a line with `[image]`.
const IMAGE_REQUEST_LINE =
  /^[ \t]*(?:[-*]\s+)?\[IMAGE\][ \t]+([^\n]+?)[ \t]*$/gim;

// A code fence whose ENTIRE content is [IMAGE] lines (weak models sometimes
// backtick the token). Unwrapped so the line parser above can see them;
// normal code blocks are never touched because every line must be a token.
const IMAGE_FENCE =
  /```[a-z]*\s*\n((?:[ \t]*(?:[-*]\s+)?\[IMAGE\][ \t]+[^\n]*\n?)+)\s*```/gi;

export function parseImageRequestsFromAnswer(answer: string): ImageRequestParse {
  const text = (answer ?? '').trim();
  if (!text) return { subjects: [], cleanText: text };

  const subjects: string[] = [];
  const noteSubject = (raw: string): void => {
    const s = raw.trim();
    if (s && subjects.length < MAX_IMAGE_QUERIES) subjects.push(s);
  };

  let clean = text.replace(IMAGE_FENCE, (_m, inner: string) => inner);
  clean = clean.replace(IMAGE_REQUEST_LINE, (_m, subject: string) => {
    noteSubject(subject);
    return '';
  });

  clean = clean
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { subjects, cleanText: clean };
}
