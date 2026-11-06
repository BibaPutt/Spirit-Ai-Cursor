import { describe, expect, it } from 'vitest';
import { streamDisplayText } from '../renderer/lib/streamDisplay';

describe('streamDisplayText', () => {
  it('1. shows only the [REPLY] payload and drops narration', () => {
    expect(streamDisplayText('Let me think about this.\n[REPLY] Here is the answer [/REPLY]')).toBe(
      'Here is the answer',
    );
  });

  it('2. keeps an unclosed [REPLY] payload streaming to the end', () => {
    expect(streamDisplayText('narration\n[REPLY] Still typing the answer')).toBe(
      'Still typing the answer',
    );
  });

  it('3. handles a fenced [REPLY] block', () => {
    expect(streamDisplayText('```text\n[REPLY] the answer\n[/REPLY]\n```')).toBe('the answer');
  });

  it('4. is case-insensitive on tags', () => {
    expect(streamDisplayText('junk [reply] answer [/reply]')).toBe('answer');
  });

  it('5. leaves plain text untouched', () => {
    expect(streamDisplayText('  hello world  ')).toBe('hello world');
  });

  it('6. strips [IMAGE] lines', () => {
    expect(streamDisplayText('a cat\n[IMAGE] a cat')).toBe('a cat');
  });

  it('7. strips stray control-block tags', () => {
    expect(streamDisplayText('before [NEXT_ACTIONS] after')).toMatch(/before\s+after/);
    expect(streamDisplayText('[UI] [/UI]')).toBe('');
  });

  it('8. strips tool-call junk', () => {
    expect(streamDisplayText('x call:ui_click(id="el1") y')).toMatch(/x\s+y/);
    expect(streamDisplayText('ui_read("el1")')).toBe('');
  });

  it('9. strips chat-template tokens', () => {
    expect(streamDisplayText('a <|start_of_turn|> b')).toMatch(/a\s+b/);
  });

  it('10. hides a trailing partial tag instead of flashing it', () => {
    expect(streamDisplayText('thoughts [REPL')).toBe('thoughts');
    expect(streamDisplayText('thoughts [NEXT_ACT')).toBe('thoughts');
  });

  it('11. hides a partial close tag after a payload', () => {
    expect(streamDisplayText('[REPLY] answer [/REPL')).toBe('answer');
  });

  it('12. strips thought tags and partial thought openers', () => {
    // Safety net removes the MARKERS (main extractor routes content); no
    // raw [THOUGHT]-shaped text may reach the typing view.
    const out = streamDisplayText('hi [THOUGHT x]secret[/THOUGHT] bye');
    expect(out).not.toMatch(/\[.*THOUGHT.*\]/i);
    expect(streamDisplayText('hi [ THOUGHT ] bye')).not.toMatch(/\[.*THOUGHT.*\]/i);
    expect(streamDisplayText('thinking [THOU')).toBe('thinking');
  });
});
