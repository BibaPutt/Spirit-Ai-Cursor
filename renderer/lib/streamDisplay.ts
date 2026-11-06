// Live-only display cleaning for the ACCUMULATED streaming response. The main
// process already filters most control markers out of every streamed chunk
// (makeStreamCleaner), but two things can still leak into the typing view:
//
//   1. `[REPLY]…[/REPLY]` tags are deliberately passed through the main
//      cleaner so THIS module can show only the payload — the moment the open
//      tag arrives, the pre-tag narration retroactively disappears, matching
//      the final-answer behavior of stripReplyPayload.
//   2. A block open tag that lands at the very end of a chunk (mid-line) can
//      slip past the main line buffer; strip it as a safety net.
//
// Applied ONLY while streaming — the final answer replaces the text and is
// already clean, so it must never pass through here.

const IMAGE_LINE_RE = /(?:^|\n)[ \t]*(?:[-*][ \t]+)?\[IMAGE\][^\n]*/gi;
const BLOCK_TAG_RE = /\[(?:\/)?(?:NEXT_ACTIONS|UI|QUESTIONS|MERMAID|DIAGRAM|OPENUI)\]/gi;
// Thought tags in any spacing/attribute shape — stripped from live display
// (thoughts live only in the expanded ChainPanel).
const THOUGHT_TAG_RE = /\[\s*\/?\s*(?:THOUGHT|THINKING|THINK)\b[^\]]*\]/gi;
const REPLY_TAG_RE = /\[(?:\/)?REPLY\]/gi;
const TOOL_CALL_RE = /call:\s*\w+\s*(?:\([^)]*\)|\{[^}]*\}|\[[^\]]*\])/gi;
const BARE_TOOL_RE =
  /(?<![A-Za-z0-9])(?:fetch_url|open_url|copy_to_clipboard|save_document|reveal_in_finder|read_clipboard|launch_app|play_music|search_web|set_volume|type_text|press_key|double_click|move_mouse|see_screen|ui_read|ui_click|read_table|paste_table|paste_image|web_search|list_apps|system_action|run_command)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;
const TEMPLATE_TOKEN_RE =
  /<\|[^>]*>|<\/?(?:tool_call|tool_response|end_of_turn|start_of_turn)[^>]*>/gi;

// A reply open tag in full form ([REPLY], [reply]) — enough to slice after.
const REPLY_OPEN_RE = /\[[ \t]*REPLY[ \t]*\]/i;
// A trailing, still-incomplete tag with no closing bracket — hide it rather
// than flash a half-typed marker ("…[REPL", "…[NEXT_ACT", "…[THOU").
const PARTIAL_TAG_TAIL_RE =
  /\[[ \t]*\/?[ \t]*(?:REP|IMAG|NEXT_ACT|UI|QUESTION|MERMAID|DIAGRAM|OPENUI|THOU|THINKING|THINK|tool_call|start_of_turn|end_of_turn)[A-Z_]*$/i;

// Returns ONLY the payload of a [REPLY]…[/REPLY] block when one is present
// (mirrors stripReplyPayload: unclosed → payload to the end; none → unchanged).
function sliceToReplyPayload(text: string): string {
  const open = text.match(REPLY_OPEN_RE);
  if (!open || open.index === undefined) return text;
  const afterOpen = text.slice(open.index + open[0].length);
  const close = afterOpen.search(/\[[ \t]*\/[ \t]*REPLY[ \t]*\]/i);
  if (close >= 0) return afterOpen.slice(0, close);
  return afterOpen;
}

// Clean the LIVE streamed text for display. Never touches the settled answer.
export function streamDisplayText(text: string): string {
  let t = sliceToReplyPayload(text);
  t = t
    .replace(IMAGE_LINE_RE, '')
    .replace(BLOCK_TAG_RE, '')
    .replace(THOUGHT_TAG_RE, '')
    .replace(REPLY_TAG_RE, '')
    .replace(TOOL_CALL_RE, '')
    .replace(BARE_TOOL_RE, '')
    .replace(TEMPLATE_TOKEN_RE, '')
    .replace(PARTIAL_TAG_TAIL_RE, '');
  return t.trim();
}
