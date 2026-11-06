// Pure, dependency-free text cleaning for STREAMED model output. Kept out of
// the provider layer so it can be unit-tested directly. The router's
// onFinalAnswer replaces the final text, but raw tool-call junk, `[IMAGE]
// <subject>` tokens and the whole `[NEXT_ACTIONS]…[/NEXT_ACTIONS]`,
// `[UI]…[/UI]`, `[QUESTIONS]…[/QUESTIONS]`, `[MERMAID]…[/MERMAID]` and
// `[DIAGRAM]…[/DIAGRAM]` blocks would otherwise flash in the response box
// while the model emits them.
//
// `[REPLY]…[/REPLY]` tags are deliberately PASSED THROUGH: the renderer shows
// only the payload live (streamDisplayText) so the pre-tag narration
// retroactively disappears the moment the open tag arrives, matching the
// final-answer behavior of stripReplyPayload.

// Strip llama.cpp chat-template special tokens (<tool_call|>, <|start_of_turn|>,
// </tool_call>…) and any of the closing/summary tags weak models sometimes wrap
// the answer in. Used both for streaming and final-answer cleaning. NOTE: no
// .trim() here — trimming per LINE (or per chunk) would eat the leading space
// of the next word at every chunk/line boundary, smashing words together
// ("hello world" + " this is a cow" → "helloworldthis is a cow"). Callers that
// need an answer-level trim do it themselves.
export function stripTemplateTokens(text: string): string {
  return text
    .replace(/<\|[^>]*>/g, '')
    .replace(/<[^>]*\|[^>]*>/g, '')
    .replace(/<\/?(?:tool_call|tool_response|end_of_turn|start_of_turn)[^>]*>/gi, '')
    .replace(/<\/?(?:final_answer|answer|done|result|output|response)[^>]*>/gi, '')
    .replace(/\b(?:final_answer|tool_call|tool_response|end_of_turn|start_of_turn)>/gi, '');
}

// Tool names that contain an underscore, mirroring the keys of the TOOLS
// registry. Used to build the bare tool-invocation regex below.
const TOOL_NAMES = [
  'fetch_url',
  'open_url',
  'copy_to_clipboard',
  'save_document',
  'reveal_in_finder',
  'read_clipboard',
  'launch_app',
  'play_music',
  'search_web',
  'set_volume',
  'type_text',
  'press_key',
  'double_click',
  'move_mouse',
  'see_screen',
  'ui_read',
  'ui_click',
  'read_table',
  'paste_table',
  'paste_image',
  'web_search',
  'list_apps',
  'system_action',
  'run_command',
];

// Match bare underscored tool invocations written as text (`ui_click("el3")`,
// `see_screen()`, `fetch_url(...)`). Built once — prose never contains these.
let bareToolCallRe: RegExp | null = null;
function getBareToolCallRe(): RegExp {
  if (!bareToolCallRe) {
    bareToolCallRe = new RegExp(
      '(?<![A-Za-z0-9])(' + TOOL_NAMES.join('|') + ')\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)',
      'gi',
    );
  }
  return bareToolCallRe;
}

// Streaming filter that hides control blocks from the text the user sees WHILE
// it streams. `[IMAGE] <subject>` lines and the data blocks are data for the
// UI — they must never be visible mid-typing. A block spans chunks (the open
// tag, the payload lines and the close tag arrive in separate network
// chunks), so a persistent line buffer holds back any line that may belong to
// a block and flushes everything else immediately. The final answer replaces
// the stream anyway; this only stops the ugly mid-typing leak. Tool-call junk
// is stripped per line.
export function makeStreamCleaner(): (chunk: string) => string {
  // Each block kind is a distinct open/close tag pair; the current block is
  // tracked by its close tag so interleaved block types never cross-match.
  const BLOCKS = [
    { open: '[NEXT_ACTIONS]', close: '[/NEXT_ACTIONS]' },
    { open: '[UI]', close: '[/UI]' },
    { open: '[QUESTIONS]', close: '[/QUESTIONS]' },
    { open: '[MERMAID]', close: '[/MERMAID]' },
    { open: '[DIAGRAM]', close: '[/DIAGRAM]' },
    { open: '[OPENUI]', close: '[/OPENUI]' },
  ];
  let pending = '';
  let currentClose: string | null = null;

  const junkClean = (line: string): string =>
    stripTemplateTokens(line)
      .replace(/call:\s*\w+\s*(?:\([^)]*\)|\{[^}]*\}|\[[^\]]*\])/g, '')
      .replace(getBareToolCallRe(), '');

  const isFence = (l: string): boolean => /^[ \t]*```\s*$/.test(l);
  const isImageLine = (l: string): boolean =>
    /^(?:[-*]\s+)?\[IMAGE\][ \t]+[^\n]*$/i.test(l.trimStart());
  // A held tail that may grow into a control line on the next chunk.
  const isHoldCandidate = (l: string): boolean =>
    /^(?:[-*]\s+)?\[(?:image|next_actions|\/next_actions|ui|\/ui|questions|\/questions|mermaid|\/mermaid|diagram|\/diagram|openui|\/openui)/i.test(
      l.trimStart(),
    );

  return (chunk: string): string => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    const out: string[] = [];

    for (const raw of lines) {
      if (currentClose) {
        if (isFence(raw)) continue;
        const closeTag = currentClose;
        const closeAt = raw.toUpperCase().indexOf(closeTag);
        if (closeAt >= 0) {
          currentClose = null;
          const rest = raw.slice(closeAt + closeTag.length);
          if (rest.trim()) out.push(junkClean(rest));
          if (isFence(out[out.length - 1] ?? '')) out.pop();
        }
        continue;
      }
      if (isImageLine(raw)) continue;
      const up = raw.toUpperCase();
      // Earliest block-open tag on the line wins.
      let openAt = -1;
      let openKind = -1;
      for (let i = 0; i < BLOCKS.length; i++) {
        const idx = up.indexOf(BLOCKS[i].open);
        if (idx >= 0 && (openAt === -1 || idx < openAt)) {
          openAt = idx;
          openKind = i;
        }
      }
      if (openAt >= 0) {
        const block = BLOCKS[openKind];
        const before = raw.slice(0, openAt);
        const afterOpen = raw.slice(openAt + block.open.length);
        const closeAt = afterOpen.toUpperCase().indexOf(block.close);
        if (closeAt >= 0) {
          // Whole block on a single line.
          const rest = afterOpen.slice(closeAt + block.close.length);
          const joined = before + rest;
          if (joined.trim()) out.push(junkClean(joined));
        } else {
          currentClose = block.close;
          if (before.trim()) out.push(junkClean(before));
        }
        continue;
      }
      // Lone close tag outside a block — drop just the tag.
      let closeAt = -1;
      let closeLen = 0;
      for (const block of BLOCKS) {
        const idx = up.indexOf(block.close);
        if (idx >= 0 && (closeAt === -1 || idx < closeAt)) {
          closeAt = idx;
          closeLen = block.close.length;
        }
      }
      if (closeAt >= 0) {
        const before = raw.slice(0, closeAt);
        const rest = raw.slice(closeAt + closeLen);
        const joined = before + rest;
        if (joined.trim()) out.push(junkClean(joined));
        continue;
      }
      out.push(junkClean(raw));
    }

    // Flush the held tail unless it may be the start of a control line or the
    // close tag of an open block has not arrived yet.
    let tail = '';
    if (!currentClose && pending.trim() && !isHoldCandidate(pending)) {
      tail = junkClean(pending);
      pending = '';
    }
    if (out.length === 0 && !tail) return '';
    // Completed lines and the flushed tail are separate source lines — they
    // must join with a newline, NOT be concatenated. Dropping the separator
    // here smashes words together ("hello world\nthis is a cow" →
    // "helloworldthis is a cow") whenever one chunk carries a full line plus a
    // partial line.
    const joined = out.join('\n');
    if (tail) return joined ? joined + '\n' + tail : tail;
    return joined + (out.length ? '\n' : '');
  };
}
