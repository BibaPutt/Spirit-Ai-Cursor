// Live-masking of the model-emitted UI blocks ([UI] / [QUESTIONS] / [MERMAID])
// for the STREAMING path. The renderer shows a small placeholder tile with the
// block's title while the AI is still emitting it, instead of flashing the raw
// JSON. This module is pure (no Electron/host imports) — the vitest suite
// exercises it directly, same contract as custom-ui-parse.
//
// Masking happens over the WHOLE streamed text (delta chunks would fight the
// retro-active masking that appears the moment a block closes and its raw JSON
// must be hidden in full). The renderer therefore REPLACES its live text with
// each chunk instead of appending (that replacement renders at the same
// ~20fps cadence as today's delta appends).
//
// Every OPEN→CLOSE region is masked out entirely (raw JSON never leaks). An
// UNCLOSED trailing region is the "in progress" block — also masked, and it
// becomes the `live` state (kind + best-effort title) shown in the placeholder.
// When the last region is closed but the final answer hasn't landed yet the
// placeholder stays on the last closed block so the UI doesn't flash before
// the authoritative segments replace it.

export type LiveUiKind = 'ui' | 'questions' | 'mermaid' | 'diagram' | 'openui';
export type LiveUiState =
  | { kind: 'ui' | 'questions' | 'mermaid' | 'diagram'; title: string }
  // Partial OpenUI Lang source streams straight into the real Renderer, so the
  // widget draws itself while the model is still writing it.
  | { kind: 'openui'; title: string; code: string }
  | null;

export type LiveUiFrame = {
  /** Streamed text with every block region removed (raw JSON hidden). */
  maskedText: string;
  /** The block currently being shown as a placeholder, if any. */
  live: LiveUiState;
};

type BlockKind = 'ui' | 'questions' | 'mermaid' | 'diagram' | 'openui' | 'next_actions';

type Tag = { isOpen: boolean; kind: BlockKind; index: number; end: number };

type Region = { kind: BlockKind; start: number; end: number; hasClose: boolean };

// The UI-block kinds get a live placeholder tile. [NEXT_ACTIONS] is masked too
// (its raw JSON/labels must never flash in the stream) but shows NO tile — the
// chips only appear with the authoritative final answer.
const UI_KINDS: LiveUiKind[] = ['ui', 'questions', 'mermaid', 'diagram', 'openui'];

// Same tolerant form the real parser accepts: `[UI]`, `[ ui ]`, `[/ui]`, etc.
const TAG_RE = /\[\s*(\/?)\s*(ui|questions|mermaid|diagram|openui|next_actions)\s*\]/gi;

function findTags(text: string): Tag[] {
  const tags: Tag[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    // Skip tags that are PROSE MENTIONS, not real blocks — "**[MERMAID]**" or
    // "`[MERMAID]`" reference the block name mid-sentence. Treating one as an
    // open tag leaves it unclosed and masks everything after it (mirror of the
    // custom-ui-parse guard).
    const tagEnd = m.index + m[0].length;
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    const after = text.slice(tagEnd, tagEnd + 2);
    if (before === '**' && after === '**') continue;
    if (m.index > 0 && text[m.index - 1] === '`' && tagEnd < text.length && text[tagEnd] === '`') continue;
    tags.push({
      isOpen: m[1] !== '/',
      kind: m[2].toLowerCase() as BlockKind,
      index: m.index,
      end: tagEnd,
    });
  }
  return tags;
}

const DEFAULT_TITLES: Record<BlockKind, string> = {
  ui: 'Component',
  questions: 'Questions',
  mermaid: 'Diagram',
  diagram: 'Diagram',
  openui: 'OpenUI',
  next_actions: 'Next actions',
};

function extractTitle(region: Region, text: string): string {
  const between = region.hasClose
    ? text.slice(region.start, region.end)
    : text.slice(region.start);
  if (region.kind === 'mermaid' || region.kind === 'diagram') {
    // Block bodies carry `%% Title` on the first comment line.
    const firstLine = (between.match(/^%%\s*(.*)$/m)?.[1] ?? '').trim();
    if (firstLine) {
      const after = firstLine.replace(/^title:\s*/i, '').trim();
      return after || DEFAULT_TITLES.mermaid;
    }
    return DEFAULT_TITLES[region.kind];
  }
  if (region.kind === 'openui') {
    // First human string in the program is almost always the CardHeader title.
    const t = between.match(/(?:CardHeader|InlineHeader)\s*\(\s*"((?:[^"\\]|\\.)*)"/);
    if (t) return t[1].trim();
    return DEFAULT_TITLES.openui;
  }
  const t = between.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (t) return t[1].trim();
  return DEFAULT_TITLES[region.kind];
}

export function liveUiFrom(text: string): LiveUiFrame {
  if (!text) return { maskedText: text, live: null };
  const tags = findTags(text);
  if (tags.length === 0) return { maskedText: text, live: null };

  // Pair close tags with the innermost OPEN of the same kind (mirrors the
  // stack behavior of custom-ui-parse so interleaved blocks stay separate).
  const openKinds = new Map<BlockKind, number[]>();
  const openIndex = new Map<number, number>();
  const openByKind = new Map<number, BlockKind>();
  const closed = new Map<number, { start: number; end: number }>();
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.isOpen) {
      const k = openKinds.get(t.kind) ?? [];
      k.push(i);
      openKinds.set(t.kind, k);
      openIndex.set(i, t.index);
      openByKind.set(i, t.kind);
    } else {
      const k = openKinds.get(t.kind) ?? [];
      const oi = k.pop();
      openKinds.set(t.kind, k);
      if (oi !== undefined) {
        closed.set(oi, { start: openIndex.get(oi)!, end: t.end });
      }
    }
  }

  // Regions: closed ones plus the outermost still-open trailing block (the
  // "in progress" candidate — only the LAST open, to avoid double-masking).
  const regions: Region[] = [];
  for (const [oi, { start, end }] of closed) {
    regions.push({ kind: openByKind.get(oi)!, start, end, hasClose: true });
  }
  for (const k of [...UI_KINDS, 'next_actions'] as const) {
    const opens = openKinds.get(k);
    if (opens && opens.length > 0) {
      const oi = opens[opens.length - 1]; // only the last unclosed of its kind
      const start = openIndex.get(oi)!;
      regions.push({ kind: k, start, end: text.length, hasClose: false });
    }
  }
  if (regions.length === 0) return { maskedText: text, live: null };

  regions.sort((a, b) => a.start - b.start);

  // Which region drives the placeholder? The last UI-kind region (trailing
  // in-progress preferred; otherwise the last closed one — final hasn't
  // replaced it yet). [NEXT_ACTIONS] regions are masked but NEVER drive a
  // placeholder, so a trailing chips block doesn't hide an open UI block.
  let maskedText = '';
  let cursor = 0;
  let live: LiveUiState = null;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    // Ignore a region swallowed inside another (shouldn't happen with the
    // stack pairing, but guard anyway).
    if (r.start < cursor) continue;
    maskedText += text.slice(cursor, r.start);
    cursor = Math.max(cursor, r.end);
    if (r.kind !== 'next_actions') {
      if (r.kind === 'openui') {
        // Feed the partial program (tags stripped) to the real Renderer so the
        // widget appears and grows while the model is still writing it.
        const code = text
          .slice(r.start, r.end)
          .replace(/\[\s*\/?\s*openui\s*\]/gi, '')
          .trim();
        live = { kind: 'openui', title: extractTitle(r, text), code };
      } else {
        live = { kind: r.kind, title: extractTitle(r, text) };
      }
    }
  }
  maskedText += text.slice(cursor);

  return { maskedText, live };
}