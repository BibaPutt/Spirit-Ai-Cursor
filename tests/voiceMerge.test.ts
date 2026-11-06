import { describe, expect, it } from 'vitest';
import { mergeTranscript, mergeTranscripts } from '../renderer/lib/voiceMerge';

describe('mergeTranscript', () => {
  it('stitches disjoint chunks with a single space', () => {
    expect(mergeTranscript('click the', 'circle icon')).toBe('click the circle icon');
  });

  it('collapses a word truncated at the slice boundary into its completed form', () => {
    // previous slice ends mid-word "hel", next slice starts "hello you"
    expect(mergeTranscript('please say hel', 'hello you')).toBe('please say hello you');
    // reverse: next echoes a truncated copy of the completed word in prev
    expect(mergeTranscript('say hello yo', 'yo')).toBe('say hello yo');
  });

  it('drops an exact repeated tail/head', () => {
    expect(mergeTranscript('open the settings', 'settings panel')).toBe('open the settings panel');
    expect(mergeTranscript('export the report now', 'report now please')).toBe(
      'export the report now please',
    );
  });

  it('keeps the longer overlap when several words match', () => {
    expect(mergeTranscript('save the file as', 'file as pdf')).toBe('save the file as pdf');
  });

  it('handles word splits where prev completes and next continues', () => {
    // prev captured the whole word already, next starts cleanly after it
    expect(mergeTranscript('version vervielfältigen änd', 'ändern konto')).toBe(
      'version vervielfältigen ändern konto',
    );
  });

  it('is case-insensitive for overlap but preserves the original casing', () => {
    expect(mergeTranscript('Open The', 'THE Settings')).toBe('Open The Settings');
  });

  it('treats empty pieces as non-content', () => {
    expect(mergeTranscript('', 'hello')).toBe('hello');
    expect(mergeTranscript('hello', '')).toBe('hello');
    expect(mergeTranscript('', '')).toBe('');
    expect(mergeTranscript('  spaced  ', '  out  ')).toBe('spaced out');
  });

  it('never mangles punctuation (merges greedily on whitespace only)', () => {
    expect(mergeTranscript('long dash —', 'caution: wet floor')).toBe('long dash — caution: wet floor');
  });
});

describe('mergeTranscripts', () => {
  it('folds many live chunks into one clean transcript', () => {
    const parts = [
      'spirit can you',
      'open the settings',
      'settings panel and',
      'and disable notif',
      'notifications',
    ];
    expect(mergeTranscripts(parts)).toBe(
      'spirit can you open the settings panel and disable notifications',
    );
  });

  it('returns empty for no content', () => {
    expect(mergeTranscripts([])).toBe('');
    expect(mergeTranscripts(['', '  '])).toBe('');
  });
});