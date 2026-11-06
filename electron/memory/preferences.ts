// Behavior-only preference memory (Letta sleep-time distillation + ACT-R
// decay): counters over WHAT the user does — the hour they submit, which
// app they are in — never what they type. Nothing raw is stored or logged.
// Weights decay with a 14-day half-life and prune below a floor on every
// load, so stale habits fade instead of piling up (forgetting by design).
// The submit path renders one compact `Preferences:` line into the system
// message, gated on the existing personalizePrompts setting — no new UI.

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeAppKey } from './app-lessons';

export type PreferencesState = {
  version: 1;
  // hour-of-day (0-23) → decayed activity weight
  hours: Record<string, number>;
  // normalized app key → decayed weight + last seen
  apps: Record<string, { w: number; lastAt: number }>;
  updatedAt: number;
};

const HALF_LIFE_DAYS = 14;
// Prune floor: below this a counter has faded to noise. Kept well under 1 so
// a single +1 event survives the next hour's decay pass (a floor of 1 made
// every decay prune the previous increment and counters never accumulated).
const MIN_WEIGHT = 0.25;
// A "usually" claim needs real repetition, not one lucky submit.
const HOUR_PEAK_MIN = 3;
const APP_DOMINANT_MIN = 4;
const APP_DOMINANCE_SHARE = 0.6;
const HOUR_CAP = 48;
const MAX_APPS = 12;
const LINE_MARKER = 'Preferences: ';

let state: PreferencesState = emptyState();
let loaded = false;
let forcedPath: string | null = null;

// Tests can point the store at a temp file (call before any note/read, and
// set to null afterwards to reset the module).
export function setPreferencesStorePathForTests(p: string | null): void {
  forcedPath = p;
  state = emptyState();
  loaded = false;
}

function emptyState(): PreferencesState {
  return { version: 1, hours: {}, apps: {}, updatedAt: Date.now() };
}

function storePath(): string {
  if (forcedPath) return forcedPath;
  try {
    return join(app.getPath('userData'), 'preferences.json');
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
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as PreferencesState;
    if (parsed && typeof parsed === 'object' && parsed.version === 1) {
      state = decayState(parsed, Date.now());
    }
  } catch {
    state = emptyState();
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

// Exponential decay since the last update: every half-life the weights halve,
// and anything that has faded below the floor is dropped (forgetting).
export function decayState(s: PreferencesState, now: number): PreferencesState {
  const days = Math.max(0, (now - s.updatedAt) / 86_400_000);
  const factor = Math.pow(0.5, days / HALF_LIFE_DAYS);
  if (factor >= 0.999) return { ...s, updatedAt: now };
  const hours: Record<string, number> = {};
  for (const [h, w] of Object.entries(s.hours ?? {})) {
    const v = w * factor;
    if (v >= MIN_WEIGHT) hours[h] = v;
  }
  const apps: PreferencesState['apps'] = {};
  for (const [k, v] of Object.entries(s.apps ?? {})) {
    const w = (v?.w ?? 0) * factor;
    if (w >= MIN_WEIGHT) apps[k] = { w, lastAt: v.lastAt };
  }
  return { version: 1, hours, apps, updatedAt: now };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Pure: longest circular run of "active" hours (≥40% of the busiest hour),
// e.g. [8,9,10,11,12,13,14,15] → 08:00–16:00. Returns null when there is no
// meaningful cluster (sparse or spread-across-the-clock data).
export function activeHourRange(hours: Record<string, number>): [number, number] | null {
  const weights = new Array<number>(24).fill(0);
  for (const [h, w] of Object.entries(hours)) {
    const i = Number(h);
    if (Number.isInteger(i) && i >= 0 && i < 24) weights[i] = w;
  }
  const max = Math.max(...weights);
  if (max < HOUR_PEAK_MIN) return null;
  const active = weights.map((w) => w >= max * 0.4 && w >= MIN_WEIGHT);
  // Longest circular run: walk a doubled array from each active start.
  let bestStart = -1;
  let bestLen = 0;
  for (let start = 0; start < 24; start++) {
    if (!active[start] || active[(start + 23) % 24]) continue; // run must start here
    let len = 0;
    while (len < 24 && active[(start + len) % 24]) len++;
    if (len > bestLen) {
      bestLen = len;
      bestStart = start;
    }
  }
  if (bestStart < 0 || bestLen < 3) return null;
  return [bestStart, (bestStart + bestLen) % 24];
}

// Pure: one compact line (or '') derived from the decayed counters. Only
// stable habits qualify — a handful of submissions never becomes a "usually".
export function derivePreferenceLine(s: PreferencesState): string {
  const parts: string[] = [];
  const range = activeHourRange(s.hours ?? {});
  if (range) {
    const [lo, hi] = range;
    parts.push(`usually active ${pad2(lo)}:00-${pad2(hi)}:00`);
  }
  const appEntries = Object.entries(s.apps ?? {}).sort((a, b) => b[1].w - a[1].w);
  if (appEntries.length > 0) {
    const total = appEntries.reduce((sum, [, v]) => sum + v.w, 0);
    const [topKey, top] = appEntries[0];
    if (
      total > 0 &&
      top.w / total >= APP_DOMINANCE_SHARE &&
      top.w >= APP_DOMINANT_MIN
    ) {
      parts.push(`usually works in ${topKey}`);
    }
  }
  if (parts.length === 0) return '';
  return `${LINE_MARKER}${parts.join('; ')}.`;
}

// Glue

// Record one submit's behavior signal (hour + foreground app). Called once
// per send; stores counters only — never prompt, screen or title text.
export function noteSubmit(appKeyRaw: string, now: number = Date.now()): void {
  load();
  state = decayState(state, now);
  const h = new Date(now).getHours();
  state.hours[h] = Math.min(HOUR_CAP, (state.hours[h] ?? 0) + 1);
  // normalizeAppKey falls back to 'unknown' for empty input — never track a
  // phantom app when the foreground snapshot was unavailable.
  const raw = String(appKeyRaw ?? '').trim();
  if (raw) {
    const key = normalizeAppKey(raw);
    const cur = state.apps[key]?.w ?? 0;
    state.apps[key] = { w: Math.min(HOUR_CAP, cur + 1), lastAt: now };
    const keys = Object.keys(state.apps);
    if (keys.length > MAX_APPS) {
      keys
        .sort((a, b) => state.apps[a].w - state.apps[b].w)
        .slice(0, keys.length - MAX_APPS)
        .forEach((k) => delete state.apps[k]);
    }
  }
  state.updatedAt = now;
  save();
}

// The line injected next to the About-the-user line (same opt-in gate).
export function preferencesLine(): string {
  load();
  return derivePreferenceLine(state);
}

// Quit-time wipe (clearMemoryOnQuit): drop the counters and the file.
export function clearPreferences(): void {
  state = emptyState();
  loaded = true;
  const p = storePath();
  if (p) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function lineMarker(): string {
  return LINE_MARKER;
}
