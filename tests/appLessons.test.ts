import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'spirit-test'),
    getName: () => 'Spirit',
    getVersion: () => 'test',
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
  },
}));

import {
  composeAppLessonsBlock,
  lessonsForAppKey,
  normalizeAppKey,
  pruneStaleLessons,
  recordAppLesson,
  stripAppLessonsBlock,
  touchAppLessons,
  upsertAppLesson,
  setAppLessonsStorePathForTests,
  appLessonsBlockFor,
  appLessonsFor,
  clearAppLessons,
  STALE_LESSON_MS,
  APP_LESSONS_START,
  APP_LESSONS_END,
} from '../electron/memory/app-lessons';

describe('normalizeAppKey', () => {
  it('case-folds, drops .exe and trims', () => {
    expect(normalizeAppKey('Notepad.exe')).toBe('notepad');
    expect(normalizeAppKey('  Chrome  ')).toBe('chrome');
  });

  it('falls back to unknown for empty input', () => {
    expect(normalizeAppKey('')).toBe('unknown');
  });
});

describe('upsertAppLesson', () => {
  it('adds a lesson and re-keying refreshes instead of duplicating', () => {
    const one = upsertAppLesson({}, 'Notepad', 'focus:no-match', 'first');
    const two = upsertAppLesson(one, 'notepad.exe', 'focus:no-match', 'updated');
    const list = lessonsForAppKey(two, 'Notepad');
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('updated');
  });

  it('keeps a different app key separate', () => {
    const s = upsertAppLesson(upsertAppLesson({}, 'notepad', 'k', 'a'), 'explorer', 'k', 'b');
    expect(lessonsForAppKey(s, 'notepad')).toHaveLength(1);
    expect(lessonsForAppKey(s, 'explorer')).toHaveLength(1);
  });

  it('caps the newest lessons per app', () => {
    let s: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      s = upsertAppLesson(s as never, 'notepad', `tip-${i}`, `lesson ${i}`);
    }
    expect(lessonsForAppKey(s as never, 'notepad')).toHaveLength(8);
    const newest = lessonsForAppKey(s as never, 'notepad').map((l) => l.key);
    expect(newest).toContain('tip-19');
  });
});

describe('composeAppLessonsBlock / stripAppLessonsBlock', () => {
  const block = composeAppLessonsBlock(
    [{ key: 'a', text: 'explorer exits 1 even on success', at: 1, hits: 0, lastUsed: 1 }],
    'File Explorer',
  );

  it('includes markers and friendly intro text', () => {
    expect(block.startsWith(APP_LESSONS_START)).toBe(true);
    expect(block.endsWith(APP_LESSONS_END)).toBe(true);
    expect(block).toContain('File Explorer');
    expect(block).toContain('explorer exits 1 even on success');
  });

  it('is empty when there are no lessons', () => {
    expect(composeAppLessonsBlock([], 'notepad')).toBe('');
  });

  it('strip removes only the block, keeping surrounding content', () => {
    const mixed = `base prompt\n\n${block}\n\ntail`;
    const stripped = stripAppLessonsBlock(mixed);
    expect(stripped).toContain('base prompt');
    expect(stripped).toContain('tail');
    expect(stripped).not.toContain(APP_LESSONS_START);
  });

  it('strip leaves prompt with no block untouched', () => {
    expect(stripAppLessonsBlock('plain')).toBe('plain');
  });

  it('orders by usefulness (hits first)', () => {
    const b = composeAppLessonsBlock(
      [
        { key: 'new', text: 'fresh tip', at: 200, hits: 0, lastUsed: 200 },
        { key: 'old', text: 'proven tip', at: 100, hits: 5, lastUsed: 150 },
      ],
      'app',
    );
    expect(b.indexOf('proven tip')).toBeLessThan(b.indexOf('fresh tip'));
  });

  it('refreshing a lesson keeps earned hits', () => {
    const one = upsertAppLesson({}, 'app', 'k', 'first');
    const touched = { ...one, app: one.app.map((l) => ({ ...l, hits: 3 })) };
    const two = upsertAppLesson(touched, 'app', 'k', 'updated');
    expect(lessonsForAppKey(two, 'app')[0].hits).toBe(3);
    expect(lessonsForAppKey(two, 'app')[0].text).toBe('updated');
  });
});

describe('pruneStaleLessons', () => {
  it('drops old unused lessons but keeps reused ones', () => {
    const now = Date.now();
    const old = now - STALE_LESSON_MS - 1000;
    const s = pruneStaleLessons(
      {
        app: [
          { key: 'dead', text: 'never helped', at: old, hits: 0, lastUsed: old },
          { key: 'alive', text: 'helps often', at: old, hits: 4, lastUsed: old },
          { key: 'fresh', text: 'new tip', at: now, hits: 0, lastUsed: now },
        ],
      },
      now,
    );
    expect(s.app.map((l) => l.key).sort()).toEqual(['alive', 'fresh']);
  });
});

describe('touchAppLessons (disk)', () => {
  it('bumps hits when lessons are injected', () => {
    const file = join(tmpdir(), `spirit-app-lessons-touch-${Date.now()}.json`);
    setAppLessonsStorePathForTests(file);
    try {
      recordAppLesson('notepad', 'k', 'tip');
      expect(appLessonsFor('notepad')[0].hits).toBe(0);
      touchAppLessons('notepad', Date.now());
      expect(appLessonsFor('notepad')[0].hits).toBe(1);
      expect(touchAppLessons('missing-app')).toBe(false);
    } finally {
      setAppLessonsStorePathForTests(null);
    }
  });
});

describe('app-lessons store (disk)', () => {
  it('records, reloads and clears via a temp store', () => {
    const file = join(tmpdir(), `spirit-app-lessons-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    setAppLessonsStorePathForTests(file);
    try {
      expect(appLessonsFor('explorer')).toEqual([]);
      recordAppLesson('explorer', 'gui-launch:explorer', 'explorer exits 1 on success');
      expect(appLessonsFor('explorer')).toHaveLength(1);
      expect(appLessonsBlockFor('explorer', 'File Explorer')).toContain('exits 1');
      expect(appLessonsBlockFor('notepad')).toBe('');
      clearAppLessons('explorer');
      expect(appLessonsFor('explorer')).toEqual([]);
    } finally {
      setAppLessonsStorePathForTests(null);
    }
  });
});