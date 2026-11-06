// Groundedness eval harness for Spirit answers.
//
// The app labels a finite set of facts as evidence for a turn: the screenshot
// OCR, the selected text, the clipboard, and the app context (CONTEXT AS OF /
// Current app / Active tab / Active URL). A grounded answer only makes claims
// that are supported by that labeled context — or by real tool results in the
// conversation. The most precisely checkable claim is a URL: a URL the model
// wrote that does not appear in the labeled context is either invented or
// fetched mid-run, and the harness flags it for review.
//
// This module is pure (no Electron, no provider) so the vitest suite can drive
// it directly as a regression harness: a future answer-parser change that
// starts leaking invented links fails here before it reaches the UI.

export const URL_RE = /https?:\/\/[^\s<>"')\]}\\]+/gi;

// Extract candidate URLs from a model answer (bare http(s) URLs, including
// inside markdown links). Returns them in order of appearance.
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  return matches.map((m) => m.replace(/[.,;:!?]+$/, ''));
}

// Canonical form for comparison: scheme+www stripped (so "http://example.com/"
// and "https://www.example.com" compare equal), trailing slashes dropped,
// lowercased.
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Does the labeled context contain this URL (normalized)? Substring match so a
// context that carries the full path matches a shorter mention, and a context
// with query params still matches the bare path.
function contextContainsUrl(normalizedContext: string, url: string): boolean {
  const n = normalizeUrl(url);
  if (!n) return false;
  return normalizedContext.includes(n);
}

// URLs in the answer that have NO support in the labeled context. Grounded
// answers return []; every entry is a claim the model made without evidence.
export function findUngroundedUrls(answer: string, labeledContext: string): string[] {
  const context = normalizeUrl(labeledContext);
  const seen = new Set<string>();
  const ungrounded: string[] = [];
  for (const url of extractUrls(answer)) {
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!contextContainsUrl(context, url)) ungrounded.push(url);
  }
  return ungrounded;
}

// Assertion for the eval harness: throws listing every ungrounded URL so a
// regression test fails with the exact offending claims.
export function assertGrounded(answer: string, labeledContext: string): void {
  const violations = findUngroundedUrls(answer, labeledContext);
  if (violations.length > 0) {
    throw new Error(
      `Ungrounded URL claim${violations.length === 1 ? '' : 's'} in answer: ${violations.join(', ')}`,
    );
  }
}
