import { describe, expect, it } from 'vitest';
import { stripVolatileContextBlocks } from '../electron/llm/prompt';

const CLIP = 'Selected text from clipboard:\nsecret pasted text';
const APP = 'Current app:\nexplorer\nWindow: Files';
const OCR = 'Text visible on screen (from screenshot):\nsome screen words';
const BRACKET = "[The screenshot attached to THIS message is the user's CURRENT screen.]";

describe('stripVolatileContextBlocks', () => {
  it('keeps a plain prompt untouched', () => {
    expect(stripVolatileContextBlocks('what is 2+2?')).toBe('what is 2+2?');
  });

  it('cuts trailing context blocks from a first-turn message', () => {
    const text = `why is the sky blue?\n\n${CLIP}\n\n${APP}`;
    expect(stripVolatileContextBlocks(text)).toBe('why is the sky blue?');
  });

  it('keeps relevance/caption paragraphs that sit before the blocks', () => {
    const text = `what is this?\n\n[Screen note: related]\n\nCaption: 1920x1080\n\n${CLIP}`;
    expect(stripVolatileContextBlocks(text)).toBe(
      'what is this?\n\n[Screen note: related]\n\nCaption: 1920x1080',
    );
  });

  it('strips multi-paragraph block content (blank lines inside a paste)', () => {
    const text = `summarise this\n\nSelected text from clipboard:\npara one\n\npara two\n\n${APP}`;
    expect(stripVolatileContextBlocks(text)).toBe('summarise this');
  });

  it('strips blocks followed by trailing directives (follow-up shape)', () => {
    const text =
      `summarise\n\n${OCR}\n\n${APP}\n\n${BRACKET}\n\n` +
      '[ACTIVE TASK — answer ONLY this question: "summarise"]';
    expect(stripVolatileContextBlocks(text)).toBe('summarise');
  });

  it('never truncates a prompt that merely mentions a header inline', () => {
    const text = 'does the "Current app: explorer" line matter?';
    expect(stripVolatileContextBlocks(text)).toBe(text);
  });

  it('fails open when the tail after a quoted header is organic prose', () => {
    const text = 'look at this\n\nCurrent app: is a weird heading\n\nand some trailing thoughts here';
    expect(stripVolatileContextBlocks(text)).toBe(text);
  });

  it('requires a real block (header + newline + content), not free text', () => {
    const text = 'question\n\nCurrent app: is fun';
    expect(stripVolatileContextBlocks(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(stripVolatileContextBlocks('')).toBe('');
  });
});
