import { describe, expect, it } from 'vitest';
import { matchVoiceCommand, effectiveVoiceLang } from '../renderer/lib/voiceCommands';

describe('voice command router', () => {
  it('exact match in English', () => {
    expect(matchVoiceCommand('open settings', 'en')?.commandId).toBe('settings');
    expect(matchVoiceCommand('quit', 'en')?.commandId).toBe('quit');
    expect(matchVoiceCommand('help', 'en')?.commandId).toBe('help');
  });

  it('exact match in German', () => {
    expect(matchVoiceCommand('einstellungen', 'de')?.commandId).toBe('settings');
    expect(matchVoiceCommand('hilfe', 'de')?.commandId).toBe('help');
    expect(matchVoiceCommand('beenden', 'de')?.commandId).toBe('quit');
  });

  it('prefix match captures args', () => {
    const hit = matchVoiceCommand('search the web for cats', 'en');
    expect(hit?.commandId).toBe('web');
    expect(hit?.args).toBe('cats');
  });

  it('prefix match in German', () => {
    const hit = matchVoiceCommand('suche im internet nach hunden', 'de');
    expect(hit?.commandId).toBe('web');
    expect(hit?.args).toBe('hunden');
  });

  it('Levenshtein tolerates small transcription errors', () => {
    // 'settngs' is missing an 'i' (distance 1)
    expect(matchVoiceCommand('settngs', 'en')?.commandId).toBe('settings');
    // 'helo' from 'help' (distance 1)
    expect(matchVoiceCommand('helo', 'en')?.commandId).toBe('help');
  });

  it('bails on long queries (treats them as real prompts)', () => {
    // "tell me what you can do for me today please" → 9 words > 6
    expect(matchVoiceCommand('tell me what you can do for me today please', 'en')).toBeNull();
  });

  it('returns null on unrelated phrases', () => {
    expect(matchVoiceCommand('hello', 'en')).toBeNull();
    expect(matchVoiceCommand('test', 'en')).toBeNull();
  });

  it('strips trailing punctuation', () => {
    expect(matchVoiceCommand('open settings.', 'en')?.commandId).toBe('settings');
    expect(matchVoiceCommand('hilfe!', 'de')?.commandId).toBe('help');
  });

  it('uses language-specific phrases when available', () => {
    expect(matchVoiceCommand('quitter', 'fr')?.commandId).toBe('quit');
    expect(matchVoiceCommand('aide', 'fr')?.commandId).toBe('help');
  });

  it('effectiveVoiceLang fallback chain', () => {
    expect(effectiveVoiceLang('de-DE')).toBe('de');
    expect(effectiveVoiceLang('auto')).toBe('en'); // navigator.language=en in jsdom
    expect(effectiveVoiceLang(undefined)).toBe('en');
    expect(effectiveVoiceLang('zh-CN')).toBe('en'); // unknown short code
  });
});
