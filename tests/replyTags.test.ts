import { describe, expect, it } from 'vitest';
import {
  REPLY_CHIP_PROMPT,
  CHIP_PROMPT_MAX,
  parseChipSuggestions,
  stripReplyPayload,
  withReplyChip,
  isReplyChipLabel,
} from '../electron/llm/chips-parse';

describe('stripReplyPayload', () => {
  it('1. returns only the text between the [REPLY] tags, dropping reasoning before and after', () => {
    const answer = [
      'The user wants me to reply to a message in the visible WhatsApp chat, adopting their writing style.',
      '',
      'Drafting a reply in a casual, informal tone typical of the chat:',
      '',
      '[REPLY]',
      "Hey, I'm on it! I'll get the code over to you soon. 👋",
      '[/REPLY]',
      '',
      'Let me know if you want any changes.',
    ].join('\n');
    expect(stripReplyPayload(answer)).toBe("Hey, I'm on it! I'll get the code over to you soon. 👋");
  });

  it('2. keeps the payload when it is multi-line', () => {
    const answer = [
      '[REPLY]',
      'Line one.',
      'Line two.',
      '[/REPLY]',
    ].join('\n');
    expect(stripReplyPayload(answer)).toBe('Line one.\nLine two.');
  });

  it('3. handles the reply wrapped in a code fence', () => {
    const answer = ['```', '[REPLY]', 'fenced payload', '[/REPLY]', '```'].join('\n');
    expect(stripReplyPayload(answer)).toBe('fenced payload');
  });

  it('4. handles a missing close tag (unclosed block runs to the end)', () => {
    expect(stripReplyPayload('[REPLY]\nunclosed payload')).toBe('unclosed payload');
  });

  it('5. returns the input unchanged when no tags are present (never guesses)', () => {
    const normal = 'Just a normal answer with no tags.\nSecond line.';
    expect(stripReplyPayload(normal)).toBe(normal);
  });

  it('6. handles empty / whitespace input', () => {
    expect(stripReplyPayload('')).toBe('');
    expect(stripReplyPayload('   ')).toBe('');
  });

  it('7. uses the FIRST complete block when several appear', () => {
    const answer = [
      '[REPLY]',
      'first payload',
      '[/REPLY]',
      '',
      '[REPLY]',
      'second payload',
      '[/REPLY]',
    ].join('\n');
    expect(stripReplyPayload(answer)).toBe('first payload');
  });

  it('8. skips an empty/nested block instead of leaking a stray tag', () => {
    expect(stripReplyPayload('[REPLY]\n[REPLY]\n[/REPLY]')).toBe('[REPLY]\n[REPLY]\n[/REPLY]');
    const answer = ['[REPLY]', '[/REPLY]', '', '[REPLY]', 'real payload', '[/REPLY]'].join('\n');
    expect(stripReplyPayload(answer)).toBe('real payload');
  });
});

describe('chip hidden prompts', () => {
  it('1. parses a JSON chip with a hidden prompt', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([
        { label: 'Suggest a reply', icon: 'mail', prompt: REPLY_CHIP_PROMPT },
        { label: 'Summarize', icon: 'summarize', prompt: 'Summarize the visible text into 3 bullets.' },
      ]),
    );
    expect(chips).toHaveLength(2);
    expect(chips[0].prompt).toBe(REPLY_CHIP_PROMPT);
    expect(chips[1].prompt).toBe('Summarize the visible text into 3 bullets.');
  });

  it('2. keeps chips working when a prompt is missing', () => {
    const chips = parseChipSuggestions(JSON.stringify([{ label: 'Summarize', icon: 'summarize' }]));
    expect(chips[0]).toEqual({ label: 'Summarize', icon: 'summarize', prompt: undefined });
  });

  it('3. clamps an over-long prompt', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([{ label: 'Long prompt', icon: 'sparkles', prompt: 'x'.repeat(2000) }]),
    );
    expect(chips[0].prompt!.length).toBe(CHIP_PROMPT_MAX);
  });
});

describe('withReplyChip', () => {
  it('1. injects "Suggest a reply" WITH its crafted hidden prompt when a conversation is on screen', () => {
    const chips = withReplyChip([{ label: 'Summarize', icon: 'summarize' }], 'chat');
    const reply = chips.find((c) => isReplyChipLabel(c.label));
    expect(reply).toBeDefined();
    expect(reply!.prompt).toBe(REPLY_CHIP_PROMPT);
  });

  it('2. forces the crafted prompt onto a model-emitted reply chip while carrying its label', () => {
    const chips = withReplyChip(
      [{ label: 'Reply to this', icon: 'mail', prompt: 'whatever the model wrote' }],
      'email',
    );
    const reply = chips.find((c) => isReplyChipLabel(c.label));
    expect(reply!.prompt).toBe(REPLY_CHIP_PROMPT + '\nReply to this');
  });

  it('3. removes reply chips when no conversation is on screen', () => {
    const chips = withReplyChip([{ label: 'Suggest a reply', icon: 'mail' }], null);
    expect(chips.some((c) => isReplyChipLabel(c.label))).toBe(false);
  });
});
