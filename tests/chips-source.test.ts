import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  source: 'smart' as string,
  custom: [] as Array<{ label: string; prompt: string; icon?: string }>,
  chain: [] as Array<{ provider: { id: string } }>,
}));

vi.mock('../electron/store/settings', () => ({
  getChipsUseMainProvider: () => true,
  getSettingsLight: () => ({
    chipsSource: hoisted.source,
    customChips: hoisted.custom,
    userProfile: {},
    calendarProvider: undefined,
  }),
}));

vi.mock('../electron/llm/providers/router', () => ({
  resolveChipsProviderChain: () => ({ chain: hoisted.chain }),
}));

import { generateChipSuggestions } from '../electron/llm/chips';

describe('chips source setting', () => {
  it('premade returns the built-in set with no provider call', async () => {
    hoisted.source = 'premade';
    const chips = await generateChipSuggestions('App: Notepad\nhello world');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => c.label && c.label.length <= 45)).toBe(true);
  });

  it('custom returns the user list verbatim', async () => {
    hoisted.source = 'custom';
    hoisted.custom = [
      { label: 'My sum', prompt: 'Summarize it my way' },
      { label: 'Blank', prompt: '   ' },
    ];
    const chips = await generateChipSuggestions('App: Notepad\nhello');
    expect(chips).toEqual([{ label: 'My sum', icon: 'sparkles', prompt: 'Summarize it my way' }]);
  });

  it('custom with an empty list falls back to premade', async () => {
    hoisted.source = 'custom';
    hoisted.custom = [];
    const chips = await generateChipSuggestions('App: Notepad\nhello');
    expect(chips.length).toBeGreaterThan(0);
  });

  it('empty context returns nothing in every mode', async () => {
    for (const s of ['smart', 'premade', 'custom']) {
      hoisted.source = s;
      hoisted.custom = [];
      hoisted.chain = [];
      expect(await generateChipSuggestions('   ')).toEqual([]);
    }
  });

  it('smart on a local-only chain serves premade with no provider call', async () => {
    hoisted.source = 'smart';
    hoisted.custom = [];
    hoisted.chain = [{ provider: { id: 'localai' } }, { provider: { id: 'opencode' } }];
    const chips = await generateChipSuggestions('App: Notepad\nhello world');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => c.label && c.label.length <= 45)).toBe(true);
    hoisted.chain = [];
  });
});
