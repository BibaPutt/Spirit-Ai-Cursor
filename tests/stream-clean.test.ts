import { describe, expect, it } from 'vitest';
import { makeStreamCleaner, stripTemplateTokens } from '../electron/llm/stream-clean';

// Feed a stream and concatenate the per-chunk output exactly like the
// renderer accumulates `response`.
function streamChunks(chunks: string[]): string {
  const clean = makeStreamCleaner();
  return chunks.map((c) => clean(c)).join('');
}

describe('makeStreamCleaner', () => {
  it('1. keeps a newline between a full line and a partial line in one chunk (no word smashing)', () => {
    const out = streamChunks(['hello world\nthis is a cow']);
    expect(out).toContain('hello world\nthis is a cow');
    expect(out).not.toContain('helloworld');
  });

  it('2. keeps words across a chunk boundary', () => {
    const out = streamChunks(['hello world', ' this is a cow']);
    expect(out).toBe('hello world this is a cow');
  });

  it('3. preserves multiple complete lines in one chunk', () => {
    const out = streamChunks(['line one\nline two']);
    expect(out).toContain('line one\nline two');
  });

  it('4. keeps spaces inside a single line with a partial tail', () => {
    const out = streamChunks(['alpha beta gamma']);
    expect(out).toBe('alpha beta gamma');
  });

  it('5. hides [IMAGE] lines', () => {
    const out = streamChunks(['A cat sits here\n[IMAGE] a cat\nnext line']);
    expect(out).toContain('A cat sits here');
    expect(out).toContain('next line');
    expect(out).not.toContain('[IMAGE]');
  });

  it('6. hides a [NEXT_ACTIONS] block spanning chunks', () => {
    const out = streamChunks([
      'summary\n[NEXT_ACTIONS]',
      'ui_click("el3")',
      '[/NEXT_ACTIONS]\ntail after',
    ]);
    expect(out).toContain('summary');
    expect(out).toContain('tail after');
    expect(out).not.toContain('[NEXT_ACTIONS]');
    expect(out).not.toContain('ui_click');
  });

  it('7. hides a single-line [UI] block but keeps surrounding text', () => {
    const out = streamChunks(['before [UI]{x}[/UI] after\n']);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('[UI]');
    expect(out).not.toContain('[/UI]');
  });

  it('7b. a block with no trailing newline leaks only to the renderer net', () => {
    // No newline → the whole line is a held tail, which is junk-cleaned but
    // not block-parsed (matches the original cleaner). The renderer net
    // (streamDisplayText) strips the stray tags from the display.
    const out = streamChunks(['before [UI]{x}[/UI] after']);
    expect(out).toContain('[UI]');
  });

  it('8. strips call: style tool invocations', () => {
    const out = streamChunks(['thinking call:ui_click(id="el1") done']);
    expect(out).not.toContain('call:ui_click');
    expect(out).toContain('thinking');
    expect(out).toContain('done');
  });

  it('9. strips bare underscored tool invocations', () => {
    const out = streamChunks(['ui_read("el1") then ui_click()']);
    expect(out).not.toContain('ui_read');
    expect(out).not.toContain('ui_click');
  });

  it('10. strips chat-template tokens', () => {
    const out = streamChunks(['<tool_call|> <|start_of_turn|> answer']);
    expect(out).not.toContain('tool_call');
    expect(out).toContain('answer');
  });

  it('11. passes [REPLY] tags through for the renderer to slice', () => {
    const out = streamChunks(['thinking...\n[REPLY] the answer [/REPLY]']);
    expect(out).toContain('[REPLY] the answer [/REPLY]');
    expect(out).toContain('thinking...');
  });

  it('12. hides a [QUESTIONS] block across a fence', () => {
    const out = streamChunks(['intro\n```\n[QUESTIONS]\nq1\n[/QUESTIONS]\n```\noutro']);
    expect(out).toContain('intro');
    expect(out).toContain('outro');
    expect(out).not.toContain('[QUESTIONS]');
  });

  it('13. hides a multi-line [DIAGRAM] HTML block', () => {
    const out = streamChunks(['intro\n[DIAGRAM]\n%% title: CivDeploy\n<div class="dg-box">A</div>\n[/DIAGRAM]']);
    expect(out).toContain('intro');
    expect(out).not.toContain('[DIAGRAM]');
    expect(out).not.toContain('[/DIAGRAM]');
    expect(out).not.toContain('<div');
  });
});

describe('stripTemplateTokens', () => {
  it('strips llama.cpp special tokens and fake wrapper tags', () => {
    const out = stripTemplateTokens('<tool_call|>hello<|end_of_turn|> <final_answer>done</final_answer>');
    expect(out).toBe('hello done');
  });
});
