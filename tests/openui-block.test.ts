import { describe, expect, it } from 'vitest';
import { extractUiBlocks, resolveUiMarkers } from '../electron/llm/custom-ui-parse';
import { liveUiFrom } from '../electron/llm/live-ui';

const PROGRAM = [
  'root = Card([hdr, ttl, tbl])',
  'hdr = CardHeader("Q3 revenue")',
  'ttl = TextContent("Revenue grew 18% quarter over quarter.", "small")',
  'tbl = Table([Col("Region", ["EMEA", "APAC"]), Col("Revenue", ["$4.2M", "$2.8M"])])',
].join('\n');

describe('[OPENUI] extraction', () => {
  it('pulls the OpenUI Lang program out of the answer as its own segment', () => {
    const { text, blocks } = extractUiBlocks(`Here you go.\n[OPENUI]\n${PROGRAM}\n[/OPENUI]\nDone.`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'openui', code: PROGRAM });
    expect(text).not.toContain('[OPENUI]');
    expect(text).not.toContain('root = Card');

    const { segments, plainText } = resolveUiMarkers(text, blocks);
    expect(segments.map((s) => s.kind)).toEqual(['text', 'openui', 'text']);
    expect(plainText).toContain('Here you go.');
    expect(plainText).not.toContain('Card(');
  });

  it('auto-closes an unterminated block so the truncated tail still renders', () => {
    const { blocks } = extractUiBlocks(`[OPENUI]\n${PROGRAM}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('openui');
  });

  it('drops a block with no statements instead of leaking raw tags', () => {
    const { text, blocks } = extractUiBlocks(`Before [OPENUI]\njust prose, no program\n[/OPENUI] after`);
    expect(blocks).toHaveLength(0);
    expect(text).not.toContain('[OPENUI]');
    expect(text).not.toContain('just prose, no program');
    expect(text).toContain('Before');
    expect(text).toContain('after');
  });

  it('accepts a ```openui fenced program', () => {
    const { blocks, text } = extractUiBlocks('Lead\n```openui\n' + PROGRAM + '\n```\nTail');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'openui', code: PROGRAM });
    expect(text).not.toContain('root = Card');
    expect(text).not.toContain('```');
  });

  it('keeps [UI] JSON and [OPENUI] programs apart in one answer', () => {
    const ui = '{"t":"card","children":[{"t":"stat","label":"CPU","text":"42%"}]}';
    const { blocks } = extractUiBlocks(`[UI]\n${ui}\n[/UI]\n[OPENUI]\n${PROGRAM}\n[/OPENUI]`);
    expect(blocks.map((b) => b.kind)).toEqual(['ui', 'openui']);
  });
});

describe('[OPENUI] live streaming', () => {
  it('masks the raw program and hands the partial source to the renderer', () => {
    const partial = `Lead\n[OPENUI]\nroot = Card([hdr])\nhdr = CardHeader("Q3 revenue")`;
    const { maskedText, live } = liveUiFrom(partial);
    expect(maskedText).toBe('Lead\n');
    expect(maskedText).not.toContain('root = Card');
    expect(live).toMatchObject({
      kind: 'openui',
      title: 'Q3 revenue',
      code: 'root = Card([hdr])\nhdr = CardHeader("Q3 revenue")',
    });
  });

  it('grows the live code as more statements stream', () => {
    const first = liveUiFrom('[OPENUI]\nroot = Card([hdr])\nhdr = CardHeader("Report")');
    const second = liveUiFrom('[OPENUI]\nroot = Card([hdr])\nhdr = CardHeader("Report")\n');
    const a = first.live;
    const b = second.live;
    expect(a?.kind).toBe('openui');
    expect(b?.kind).toBe('openui');
    if (a?.kind !== 'openui' || b?.kind !== 'openui') throw new Error('expected openui live state');
    expect(b.code.length).toBeGreaterThanOrEqual(a.code.length);
    expect(b.code).not.toContain('[OPENUI]');
  });

  it('falls back to the generic title before a CardHeader arrives', () => {
    const { live } = liveUiFrom('[OPENUI]\nroot = Card([');
    expect(live).toEqual({ kind: 'openui', title: 'OpenUI', code: 'root = Card([' });
  });
});
