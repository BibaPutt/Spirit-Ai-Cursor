// Inline reasoning tags → Chain-of-Thought panel.
//
// Provider `reasoning_content` is only available from reasoning models — many
// local/chat models instead decorate their own thinking inline, e.g.
//
//   [THOUGHT]the user wants Downloads opened, the sidebar says "Downloads"…
//   [/THOUGHT]
//   Opening Downloads for you.
//
// The extractor is a per-run state machine fed the raw content stream. It
// splits each delta into `answer` (text outside the tags, kept for the answer
// stream) and `reasoning` (the inner text, forwarded to the reasoning panel).
// Tags may span deltas and appear anywhere; an unclosed trailing block at the
// end of the stream is treated as reasoning too (it was "thinking", not
// speech, and leaking a stray `[THOUGHT]` into the answer would be worse).
//
// Recognized openers/closers (case-insensitive): THOUGHT / THINKING / THINK.
// Tolerant of spacing (`[ THOUGHT ]`) and trailing attributes (`[THOUGHT x]`)
const OPEN_RE = /\s*\[\s*(THOUGHT|THINKING|THINK)\b[^\]]*\]\s*/i;
const CLOSE_RE = /\s*\[\s*\/(THOUGHT|THINKING|THINK)\s*\]\s*/i;
// Trailing partial opener split across deltas (`[THOU`, `[ THOUGHT`, `[/TH`).
const PARTIAL_OPEN_RE = /\[\s*\/?\s*[A-Za-z]*$/;

export type ThoughtSplit = {
  answer: string;
  reasoning: string;
};

export class ThoughtTagExtractor {
  private buf = '';
  private inside = false;

  // Consume one content delta. Returns the answer portion (to append to the
  // live answer / tool scanner) and any reasoning portion (to broadcast to the
  // Chain-of-Thought panel). Callers should drop `reasoning` from the answer
  // and forward it on its own channel.
  push(chunk: string): ThoughtSplit {
    this.buf += chunk;
    const answerParts: string[] = [];
    const reasoningParts: string[] = [];

    while (this.buf.length > 0) {
      if (!this.inside) {
        // OPEN_RE is non-global: each exec runs from the start of the buffer,
        // and we slice the matched opener away so the next pass scans the tail.
        const m = OPEN_RE.exec(this.buf);
        if (!m) {
          // No complete opener — but the tail may be a PARTIAL opener split
          // across deltas (`answer [THOU` + `GHT]...`). Hold it back instead
          // of flashing it as answer text; the next push either completes
          // the tag or disproves it.
          const tail = PARTIAL_OPEN_RE.exec(this.buf);
          if (tail) {
            if (tail.index > 0) answerParts.push(this.buf.slice(0, tail.index));
            this.buf = this.buf.slice(tail.index);
            break;
          }
          answerParts.push(this.buf);
          this.buf = '';
          break;
        }
        if (m.index > 0) answerParts.push(this.buf.slice(0, m.index));
        this.buf = this.buf.slice(m.index + m[0].length);
        this.inside = true;
      } else {
        const c = CLOSE_RE.exec(this.buf);
        if (!c) {
          // No closer in this delta — everything so far is thinking. Keep the
          // tail buffered so a split `[/THOUGHT]` in the next delta closes it.
          reasoningParts.push(this.buf);
          this.buf = '';
          break;
        }
        reasoningParts.push(this.buf.slice(0, c.index));
        this.buf = this.buf.slice(c.index + c[0].length);
        this.inside = false;
      }
    }

    return { answer: answerParts.join(''), reasoning: reasoningParts.join('') };
  }

  // End-of-stream. A held-back partial opener that never completed was not
  // a tag — release it as answer text. Inside an unclosed block, the pushes
  // already surfaced the thinking as reasoning, so nothing is left.
  flush(): ThoughtSplit {
    if (!this.inside && this.buf) {
      const answer = this.buf;
      this.buf = '';
      return { answer, reasoning: '' };
    }
    this.buf = '';
    this.inside = false;
    return { answer: '', reasoning: '' };
  }

  get open(): boolean {
    return this.inside;
  }
}

// One-shot helper for non-streaming paths (test messages, summaries). Splits a
// single complete string into answer + concatenated reasoning. An unclosed
// trailing block is treated as reasoning for symmetry with the stream path.
export function splitThoughtTags(text: string): ThoughtSplit {
  const extractor = new ThoughtTagExtractor();
  const { answer, reasoning } = extractor.push(text);
  const tail = extractor.flush();
  return { answer: answer + tail.answer, reasoning: (reasoning + tail.reasoning).trim() };
}