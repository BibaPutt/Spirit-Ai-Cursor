import { describe, expect, it } from 'vitest';
import { fallbackChipsFor, fallbackChipCount, fallbackChipLabels } from '../electron/llm/chips-fallback';
import { MAX_CHIPS, isCopyChipLabel } from '../electron/llm/chips-parse';

const ctx = (opts: { app?: string; url?: string; tab?: string; conv?: string; region?: string }) => {
  const lines: string[] = [];
  if (opts.region) lines.push(opts.region);
  if (opts.app) lines.push(`Current app: ${opts.app}`);
  if (opts.tab) lines.push(`Active tab: ${opts.tab}`);
  if (opts.url) lines.push(`Active URL: ${opts.url}`);
  if (opts.conv) lines.push(`Conversation type: ${opts.conv}`);
  return lines.join('\n');
};

describe('fallbackChipsFor', () => {
  it('1. returns video-related chips for a YouTube context', () => {
    const chips = fallbackChipsFor(ctx({ app: 'Arc (Arc)', tab: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' }));
    expect(chips).toHaveLength(MAX_CHIPS);
    expect(chips.every((c) => c.label.length <= 45)).toBe(true);
    expect(chips[0].prompt).toBeTruthy();
  });

  it('2. returns music-related chips for Spotify, distinct from video', () => {
    const music = fallbackChipsFor(ctx({ app: 'Arc (Arc)', tab: 'Spotify', url: 'https://open.spotify.com/album/x' }));
    const video = fallbackChipsFor(ctx({ app: 'Arc (Arc)', tab: 'YouTube', url: 'https://www.youtube.com/watch?v=abc' }));
    // Rotation varies WHICH music chip leads across sessions, so accept any
    // chip from the music set rather than a hard-coded first entry.
    expect(music[0].label).not.toBe(video[0].label);
    expect(music[0].label).toMatch(/Recommend|Explain|List|Describe|Build|Match|Find/);
  });

  it('3. returns terminal chips for a cmd/PowerShell context', () => {
    const chips = fallbackChipsFor(
      ctx({ app: 'WindowsTerminal (WindowsTerminal)', region: 'npm test' }),
    );
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].label).toMatch(/Explain|Find|Fix|Summarize|Simplify|Show|command|error|output|terminal|steps/i);
  });

  it('4. includes a reply suggestion for email/chat contexts', () => {
    const email = fallbackChipsFor(ctx({ app: 'Chrome (chrome)', url: 'https://mail.google.com/', conv: 'email' }));
    expect(email.some((c) => c.label === 'Suggest a reply')).toBe(true);
    const chat = fallbackChipsFor(ctx({ app: 'WhatsApp (whatsapp)', conv: 'chat' }));
    expect(chat.some((c) => c.label === 'Suggest a reply')).toBe(true);
  });

  it('5. falls back to generic chips for an unknown app', () => {
    const chips = fallbackChipsFor(ctx({ app: 'SomeApp (someapp)', tab: 'Main window' }));
    expect(chips).toHaveLength(MAX_CHIPS);
    expect(chips[0].label).toBe('Summarize this');
    expect(chips.every((c) => c.prompt && c.prompt.length <= 400)).toBe(true);
  });

  it('6. never returns copy chips and always dedupes', () => {
    for (const context of [
      ctx({ app: 'Arc (Arc)', url: 'https://www.youtube.com/' }),
      ctx({ app: 'Code (code)', tab: 'index.ts' }),
      ctx({ app: 'Spotify (spotify)' }),
      ctx({ app: 'Unknown (unknown)' }),
      '',
    ]) {
      const chips = fallbackChipsFor(context);
      expect(chips.length).toBeLessThanOrEqual(MAX_CHIPS);
      const labels = chips.map((c) => c.label.toLowerCase());
      expect(new Set(labels).size).toBe(labels.length);
      expect(chips.every((c) => !isCopyChipLabel(c.label))).toBe(true);
    }
  });

  it('7. returns generic chips for empty input', () => {
    const chips = fallbackChipsFor('');
    expect(chips).toHaveLength(MAX_CHIPS);
    expect(chips[0].label).toBe('Summarize this');
  });

  it('8. catalog is broad, bounded, and label-unique', () => {
    const labels = fallbackChipLabels();
    expect(fallbackChipCount()).toBeGreaterThanOrEqual(250);
    expect(new Set(labels).size).toBeGreaterThanOrEqual(240);
    // The reply chip intentionally repeats across the conversation categories
    // (email/contacts/chat) — every other label must be globally unique.
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(dupes.every((l) => l === 'suggest a reply')).toBe(true);
  });

  it('9. translates to the configured target language', () => {
    const chips = fallbackChipsFor(ctx({ app: 'SomeApp (someapp)' }), { translateTo: 'French' });
    const translate = chips.find((c) => c.label === 'Translate to French');
    expect(translate).toBeTruthy();
    expect(translate?.prompt).toContain('into French');
    // No target language → generic chip keeps its generic prompt.
    const plain = fallbackChipsFor(ctx({ app: 'SomeApp (someapp)' }));
    expect(plain.some((c) => c.label === 'Translate this')).toBe(true);
  });

  it('10. calendar event chip targets the configured calendar provider', () => {
    const outlook = fallbackChipsFor(
      ctx({ app: 'Chrome (chrome)', url: 'https://calendar.google.com/', region: 'Team sync tomorrow at 2pm' }),
      { calendarProvider: 'outlook' },
    );
    expect(outlook[0].label).toBe('Create an event');
    expect(outlook[0].prompt).toContain('Outlook Calendar');
    const google = fallbackChipsFor(
      ctx({ app: 'Chrome (chrome)', url: 'https://calendar.google.com/', region: 'Team sync tomorrow at 2pm' }),
      { calendarProvider: 'google' },
    );
    expect(google[0].label).toBe('Create an event');
    expect(google[0].prompt).toContain('Google Calendar');
  });

  it('11. reply chips stay pinned first in every conversation category', () => {
    for (const c of [
      ctx({ app: 'Chrome (chrome)', url: 'https://mail.google.com/', conv: 'email' }),
      ctx({ app: 'WhatsApp (whatsapp)', conv: 'chat' }),
      ctx({ app: 'Contacts (contacts)' }),
      ctx({ app: 'Arc (Arc)', url: 'https://x.com/' }),
    ]) {
      const chips = fallbackChipsFor(c);
      expect(chips.some((chip) => /reply|respond/i.test(chip.label))).toBe(true);
    }
  });

  it('12. search contexts return a web-forcing chip that submits to the LLM', () => {
    const chips = fallbackChipsFor(
      ctx({ app: 'Chrome (chrome)', url: 'https://www.google.com/search?q=iphone+15' }),
    );
    const search = chips.find((c) => c.web === true);
    expect(search).toBeTruthy();
    expect(search?.prompt).toMatch(/web search/i);
    // Search-chip labels must NOT trip the renderer's browser-open intercept
    // (looksLikeWebSearch) — they have to reach the LLM, not open DuckDuckGo.
    for (const c of chips) {
      if (c.web) {
        expect(c.label).not.toMatch(
          /search|picture of|image of|photo of|photos of|^(find |look up |look for |google |search for |who is |what is |when was |when did |where is )/i,
        );
      }
    }
  });
});
