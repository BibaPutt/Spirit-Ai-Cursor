// Per-app lessons (Phase F): a tiny durable memory of QUIRKS the agent has
// learned about specific apps/windows, so "mistakes" don't repeat across
// sessions. Tools record a short fact when they hit something notable (a GUI
// launcher that falsely reports failure, a focus attempt that missed, typing
// that landed in the wrong window); the submit path re-injects the lessons for
// the CURRENT foreground app into the system message as hints. Pure logic is
// separated (unit-testable) from the tiny electron-app + disk glue.

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type AppLesson = {
  key: string;
  text: string;
  at: number;
  // Reuse tracking (Hermes-style memory weight): bumped every time the lesson
  // is injected into a prompt. Orders recall (useful first) and drives the
  // stale-lesson GC below. Older entries lack these — backfilled on load.
  hits: number;
  lastUsed: number;
};
export type AppLessonsState = Record<string, AppLesson[]>;

export const APP_LESSONS_START = '<!--SPIRIT-APP-LESSONS-->';
export const APP_LESSONS_END = '<!--/SPIRIT-APP-LESSONS-->';

const MAX_LESSONS_PER_APP = 8;
const MAX_APPS = 40;

let state: AppLessonsState = {};
let loaded = false;
let forcedPath: string | null = null;

// Tests can point the store at a temp file (call before any record/read, and
// set to null afterwards to reset the module).
export function setAppLessonsStorePathForTests(p: string | null): void {
  forcedPath = p;
  state = {};
  loaded = false;
}

function storePath(): string {
  if (forcedPath) return forcedPath;
  try {
    return join(app.getPath('userData'), 'app-lessons.json');
  } catch {
    return '';
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const p = storePath();
  if (!p || !existsSync(p)) return;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as AppLessonsState;
    if (parsed && typeof parsed === 'object') {
      // Backfill reuse counters on pre-hits entries + drop long-dead weight.
      const now = Date.now();
      for (const k of Object.keys(parsed)) {
        const list = Array.isArray(parsed[k]) ? parsed[k] : [];
        parsed[k] = list.map((l) => ({
          key: l.key,
          text: l.text,
          at: l.at,
          hits: typeof l.hits === 'number' ? l.hits : 0,
          lastUsed: typeof l.lastUsed === 'number' ? l.lastUsed : l.at,
        }));
      }
      state = pruneStaleLessons(parsed, now);
    }
  } catch {
    state = {};
  }
}

function save(): void {
  const p = storePath();
  if (!p) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state), 'utf-8');
  } catch {
    /* best-effort persistence */
  }
}

// Pure

// Stable per-app key: process name / window title, case-folded, .exe dropped.
export function normalizeAppKey(raw: string): string {
  const key = String(raw ?? '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .trim()
    .replace(/\s+/g, ' ');
  return (key || 'unknown').slice(0, 60);
}

// Upsert one lesson per (app, key): replacing an existing tipKey refreshes its
// text + timestamp (keeping earned hits); never duplicates; keeps the newest
// MAX_LESSONS_PER_APP.
export function upsertAppLesson(
  state: AppLessonsState,
  appKey: string,
  key: string,
  text: string,
): AppLessonsState {
  const k = normalizeAppKey(appKey);
  const prev = (state[k] ?? []).find((l) => l.key === key);
  const list = (state[k] ?? []).filter((l) => l.key !== key);
  list.push({
    key,
    text,
    at: Date.now(),
    hits: prev?.hits ?? 0,
    lastUsed: prev?.lastUsed ?? Date.now(),
  });
  const capped = list.slice(-MAX_LESSONS_PER_APP);
  const next = { ...state, [k]: capped };
  const keys = Object.keys(next);
  if (keys.length > MAX_APPS) {
    const ordered = keys
      .map((kk) => [kk, next[kk][next[kk].length - 1]?.at ?? 0] as const)
      .sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < ordered.length - MAX_APPS; i++) delete next[ordered[i][0]];
  }
  return next;
}

// Retention GC: drop lessons never reused (0 hits) and untouched for
// STALE_LESSON_MS. Lessons that earned hits are kept — reuse is the signal
// the tip actually helps. Pure (unit-tested); load() applies it.
export const STALE_LESSON_MS = 60 * 24 * 60 * 60 * 1000;

export function pruneStaleLessons(state: AppLessonsState, now: number = Date.now()): AppLessonsState {
  const next: AppLessonsState = {};
  for (const k of Object.keys(state)) {
    const kept = (state[k] ?? []).filter((l) => l.hits > 0 || now - l.at < STALE_LESSON_MS);
    if (kept.length > 0) next[k] = kept;
  }
  return next;
}

// Mark an app's lessons as used (called when they are injected into a
// prompt). In-memory always; disk write throttled to one per minute so a
// chatty session doesn't fsync on every turn. Returns true when persisted.
let lastTouchSave = 0;

export function touchAppLessons(appKey: string, now: number = Date.now()): boolean {
  load();
  const k = normalizeAppKey(appKey);
  const list = state[k];
  if (!list || list.length === 0) return false;
  state[k] = list.map((l) => ({ ...l, hits: l.hits + 1, lastUsed: now }));
  if (now - lastTouchSave < 60_000) return false;
  lastTouchSave = now;
  save();
  return true;
}

export function lessonsForAppKey(state: AppLessonsState, appKey: string): AppLesson[] {
  return state[normalizeAppKey(appKey)] ?? [];
}

// The injectable prompt block (with markers so it can be stripped on follow-up
// turns like the memory block). Empty string when there is nothing to say.
// Ordered by usefulness (hits desc, then recency) so the best-earned hint
// lands first when the block is truncated downstream.
export function composeAppLessonsBlock(
  lessons: AppLesson[],
  appName?: string,
): string {
  if (lessons.length === 0) return '';
  const ordered = [...lessons].sort((a, b) => b.hits - a.hits || b.lastUsed - a.lastUsed);
  const intro = appName
    ? `Lessons learned about the CURRENT window (${appName}) in earlier sessions:`
    : 'Lessons learned about the current window in earlier sessions:';
  return (
    `${APP_LESSONS_START}\n${intro}\n` +
    ordered.map((l) => `- ${l.text}`).join('\n') +
    `\nTreat them as hints with real experience behind them — but always verify against what you see on screen.\n${APP_LESSONS_END}`
  );
}

export function stripAppLessonsBlock(content: string): string {
  const start = content.indexOf(APP_LESSONS_START);
  if (start === -1) return content;
  const end = content.indexOf(APP_LESSONS_END, start);
  if (end === -1) return content.slice(0, start).trimEnd();
  return (content.slice(0, start) + content.slice(end + APP_LESSONS_END.length)).trimEnd();
}

// IO

export function recordAppLesson(appKey: string, key: string, text: string): void {
  if (!text.trim()) return;
  load();
  state = upsertAppLesson(state, appKey, key, text);
  save();
}

export function appLessonsFor(appKey: string): AppLesson[] {
  load();
  return lessonsForAppKey(state, appKey);
}

export function appLessonsBlockFor(appKey: string, appName?: string): string {
  load();
  return composeAppLessonsBlock(lessonsForAppKey(state, appKey), appName);
}

export function clearAppLessons(appKey?: string): void {
  load();
  if (!appKey) state = {};
  else delete state[normalizeAppKey(appKey)];
  save();
}