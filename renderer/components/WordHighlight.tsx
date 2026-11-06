// Highlights the currently-spoken word during TTS playback. Primary path uses
// the CSS Custom Highlight API (Chromium 105+). Falls back to wrapping the
// word in a temporary <mark> element via Range.surroundContents() if the API
// isn't available. The parsed answer text is never replaced — highlights are
// either compositor-level (CSS highlights) or a temporary inline wrapper that
// is cleaned up before the next word.
//
// Click-to-seek: clicking any word in the answer during playback (or idle)
// seeks the TTS to that word. Uses caretRangeFromPoint to map the click
// position to a word index.
import { useEffect, useRef } from 'react';
import type { WordToken } from '../lib/ttsWords';

const HIGHLIGHT_NAME = 'spirit-word-active';
const MARK_ATTR = 'data-word-mark';

// Trailing punctuation that ReactMarkdown may place in a separate text node.
const TRAIL_RE = /[.,;:!?…""''()[\]{}«»]+$/;

function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (el.closest('pre, code, svg, .mermaid-diagram, img')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.textContent?.trim()) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

const BOUNDARY_RE = /[\s.,;:!?…""''()[\]{}«»\-—/]/;

function searchWordInNodes(
  textNodes: Text[],
  wordText: string,
  occurrence: number,
): Range | null {
  if (!wordText) return null;
  const lower = wordText.toLowerCase();
  let found = 0;
  for (const node of textNodes) {
    const text = node.textContent ?? '';
    const nodeLower = text.toLowerCase();
    let from = 0;
    while (from < text.length) {
      const idx = nodeLower.indexOf(lower, from);
      if (idx === -1) break;
      const end = idx + wordText.length;
      if ((idx === 0 || BOUNDARY_RE.test(text[idx - 1])) && (end >= text.length || BOUNDARY_RE.test(text[end]))) {
        if (found === occurrence) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, end);
          return range;
        }
        found++;
      }
      from = idx + 1;
    }
  }
  return null;
}

function findWordRange(
  textNodes: Text[],
  wordText: string,
  occurrence: number,
): Range | null {
  const exact = searchWordInNodes(textNodes, wordText, occurrence);
  if (exact) return exact;
  const stripped = wordText.replace(TRAIL_RE, '');
  if (stripped && stripped !== wordText) {
    const r = searchWordInNodes(textNodes, stripped, occurrence);
    if (r) return r;
  }
  // Fuzzy fallback: match first N chars when the word is split across nodes.
  const fuzzyLen = Math.max(3, Math.floor(stripped.length * 0.7));
  const fuzzy = stripped.slice(0, fuzzyLen);
  if (fuzzy && fuzzy !== stripped && fuzzy !== wordText) {
    return searchWordInNodes(textNodes, fuzzy, occurrence);
  }
  return null;
}

// CSS Custom Highlight path

let hlStyleInjected = false;
function ensureHighlightStyle() {
  if (hlStyleInjected) return;
  hlStyleInjected = true;
  const s = document.createElement('style');
  // --accent-rgb is SPACE-separated; use modern rgb() / syntax.
  // Dark theme (.dark = light UI in this app) needs higher opacity.
  s.textContent = [
    `::highlight(${HIGHLIGHT_NAME}){background:rgb(var(--spirit-accent-rgb) / 0.40);border-radius:2px;padding:1px 0}`,
    `.dark ::highlight(${HIGHLIGHT_NAME}){background:rgb(var(--spirit-accent-rgb) / 0.85)}`,
  ].join('\n');
  document.head.appendChild(s);
}

// <mark> fallback path

let markStyleInjected = false;
function ensureMarkStyle() {
  if (markStyleInjected) return;
  markStyleInjected = true;
  const s = document.createElement('style');
  s.textContent = [
    `[${MARK_ATTR}]{background:rgb(var(--spirit-accent-rgb) / 0.40);border-radius:2px;padding:1px 0;color:inherit}`,
    `.dark [${MARK_ATTR}]{background:rgb(var(--spirit-accent-rgb) / 0.85)}`,
  ].join('\n');
  document.head.appendChild(s);
}

function cleanupMark() {
  document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  });
}

function applyMarkHighlight(range: Range) {
  cleanupMark();
  const mark = document.createElement('mark');
  mark.setAttribute(MARK_ATTR, '');
  try {
    range.surroundContents(mark);
  } catch {
    const frag = range.extractContents();
    range.insertNode(mark);
    mark.appendChild(frag);
  }
}

// Shared highlight logic

function resolveWord(
  words: WordToken[],
  activeWord: number,
  container: Node,
): { range: Range; scrollEl: HTMLElement | null } | null {
  if (activeWord < 0 || activeWord >= words.length) return null;
  const word = words[activeWord];
  if (!word?.text) return null;

  const textNodes = collectTextNodes(container);
  const lower = word.text.toLowerCase();
  let occurrence = 0;
  for (let i = 0; i < activeWord; i++) {
    if (words[i].text.toLowerCase() === lower) occurrence++;
  }

  const range = findWordRange(textNodes, word.text, occurrence);
  if (!range) return null;

  const scrollEl =
    container instanceof HTMLElement
      ? (container.closest('.overflow-y-auto') as HTMLElement | null)
      : null;
  return { range, scrollEl };
}

function autoScroll(scrollEl: HTMLElement | null, range: Range) {
  if (!scrollEl) return;
  const rects = range.getClientRects();
  if (rects.length === 0) return;
  const rect = rects[0];
  const cr = scrollEl.getBoundingClientRect();
  if (rect.top < cr.top + 12) {
    scrollEl.scrollTop -= cr.top + 12 - rect.top;
  } else if (rect.bottom > cr.bottom - 12) {
    scrollEl.scrollTop += rect.bottom - cr.bottom + 12;
  }
}

// Click-to-seek

function findWordIndexAtClick(
  container: Node,
  clientX: number,
  clientY: number,
  words: WordToken[],
): number {
  const range = document.caretRangeFromPoint(clientX, clientY);
  if (!range) return -1;

  const textNode = range.startContainer;
  const offset = range.startOffset;
  if (textNode.nodeType !== Node.TEXT_NODE) return -1;

  const text = textNode.textContent ?? '';
  if (offset < 0 || offset > text.length) return -1;

  let wordStart = offset;
  while (wordStart > 0 && /\S/.test(text[wordStart - 1])) wordStart--;
  let wordEnd = offset;
  while (wordEnd < text.length && /\S/.test(text[wordEnd])) wordEnd++;

  const clickedRaw = text.slice(wordStart, wordEnd);
  if (!clickedRaw) return -1;

  const textNodes = collectTextNodes(container);
  const clickedLower = clickedRaw.toLowerCase();
  let occurrence = 0;

  for (const node of textNodes) {
    if (node === textNode) break;
    const t = (node.textContent ?? '').toLowerCase();
    let f = 0;
    while (f < t.length) {
      const idx = t.indexOf(clickedLower, f);
      if (idx === -1) break;
      const end = idx + clickedRaw.length;
      const bText = node.textContent ?? '';
      if ((idx === 0 || BOUNDARY_RE.test(bText[idx - 1])) && (end >= bText.length || BOUNDARY_RE.test(bText[end]))) {
        occurrence++;
      }
      f = idx + 1;
    }
  }

  const nodeLower = text.toLowerCase();
  let f = 0;
  while (f < wordStart) {
    const idx = nodeLower.indexOf(clickedLower, f);
    if (idx === -1 || idx >= wordStart) break;
    const end = idx + clickedRaw.length;
    if ((idx === 0 || BOUNDARY_RE.test(text[idx - 1])) && (end >= text.length || BOUNDARY_RE.test(text[end]))) occurrence++;
    f = idx + 1;
  }

  const candidates: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const wl = words[i].text.toLowerCase();
    if (
      wl === clickedLower ||
      wl.replace(TRAIL_RE, '') === clickedLower.replace(TRAIL_RE, '')
    ) {
      candidates.push(i);
    }
  }

  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0];

  let seen = 0;
  for (const c of candidates) {
    if (seen === occurrence) return c;
    const cl = clickedLower.replace(TRAIL_RE, '');
    if (
      words[c].text.toLowerCase() === clickedLower ||
      words[c].text.toLowerCase().replace(TRAIL_RE, '') === cl
    ) {
      seen++;
    }
  }

  return candidates[0];
}

// Component

export function WordHighlight({
  words,
  activeWord,
  seekToWord,
}: {
  words: WordToken[];
  activeWord: number;
  seekToWord?: (index: number) => void;
}) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  // Keep the last successful highlight range so the overlay doesn't flash
  // off when a word can't be resolved in the DOM (e.g. during rapid speech
  // or when a word spans multiple text nodes).
  const lastRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const container = marker.parentElement;
    if (!container) return;

    const reg =
      typeof CSS !== 'undefined'
        ? (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights
        : undefined;

    const hit = resolveWord(words, activeWord, container);

    if (reg) {
      ensureHighlightStyle();
      if (hit) {
        lastRangeRef.current = hit.range;
        reg.set(HIGHLIGHT_NAME, new Highlight(hit.range));
        autoScroll(hit.scrollEl, hit.range);
      } else if (lastRangeRef.current) {
        // Keep last visible highlight — don't flash off between words.
        try {
          reg.set(HIGHLIGHT_NAME, new Highlight(lastRangeRef.current));
        } catch {
          // Range may be detached if DOM changed; clear stale ref.
          lastRangeRef.current = null;
          reg.delete(HIGHLIGHT_NAME);
        }
      }
      return () => {
        reg.delete(HIGHLIGHT_NAME);
        lastRangeRef.current = null;
      };
    }

    // <mark> fallback path.
    ensureMarkStyle();
    if (hit) {
      lastRangeRef.current = hit.range;
      cleanupMark();
      applyMarkHighlight(hit.range);
      autoScroll(hit.scrollEl, hit.range);
    } else if (!lastRangeRef.current) {
      cleanupMark();
    }
    return () => {
      cleanupMark();
      lastRangeRef.current = null;
    };
  }, [activeWord, words]);

  // Click-to-seek.
  const seekToWordRef = useRef(seekToWord);
  seekToWordRef.current = seekToWord;

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const container = marker.parentElement;
    if (!container) return;

    const onClick = (e: MouseEvent) => {
      if (!seekToWordRef.current) return;
      const w = wordsRef.current;
      if (w.length === 0) return;
      const idx = findWordIndexAtClick(container, e.clientX, e.clientY, w);
      if (idx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        seekToWordRef.current(idx);
      }
    };

    container.addEventListener('click', onClick, { capture: true });
    return () => { container.removeEventListener('click', onClick, { capture: true }); };
  }, []);

  return <span ref={markerRef} className="hidden" aria-hidden />;
}
