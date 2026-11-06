// Development-only session logging. When the app runs unpackaged (`npm run
// dev`), every console line from the main process is appended to a per-run
// session file under <project>/logs (created on first run).
//
// Two policies keep the folder meaningful:
//   - Small sessions are skipped: a run that only logged a handful of lines
//     (e.g. a build restart that quit after a few init logs) is deleted on
//     quit and never left behind.
//   - Rotation: at most MAX_SESSION_LOGS real session files are kept; the
//     oldest are deleted.
//
// Production builds (`app.isPackaged`) never touch the filesystem here —
// console output is untouched and no folder is created. The point is a
// self-contained terminal history for the debug session ("why did the AI
// cancel", "which provider did the chips hit"), not a general-purpose logger.
import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SESSION_LOGS = 10;

// A session that wrote fewer meaningful lines than this is treated as
// noise (build/restart churn) and removed instead of kept.
export const SMALL_SESSION_MIN_LINES = 20;

function countMeaningfulLines(file: string): number {
  try {
    const text = readFileSync(file, 'utf-8');
    return text.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// Delete session files with fewer than `minLines` meaningful lines. Returns
// the names removed. Pure and exported so the policy is unit-testable.
export function pruneSmallSessionLogs(dir: string, minLines: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!/^session-.*\.log$/.test(name)) continue;
    if (countMeaningfulLines(join(dir, name)) >= minLines) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      /* another session may have pruned it already */
    }
  }
  return removed;
}

// Delete session files beyond `max` (oldest first, newest kept). Returns the
// names removed. Pure and exported so the rotation policy is unit-testable.
export function rotateLogFiles(dir: string, max: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  const sessions = entries
    .filter((n) => /^session-.*\.log$/.test(n))
    .sort()
    .reverse();
  for (const name of sessions.slice(max)) {
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      /* another session may have pruned it already */
    }
  }
  return removed;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

let sessionFile = '';
let lineCount = 0;

function writeLine(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  if (!sessionFile) return;
  const text = args.map(fmtArg).join(' ');
  if (!text.trim()) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${text}`;
  try {
    appendFileSync(sessionFile, line + '\n', 'utf-8');
    lineCount += 1;
  } catch {
    /* disk failure must never break the app */
  }
}

// Small sessions (a quick restart with a few init lines) are noise — drop the
// file so only meaningful sessions survive. Fires on quit; sessions killed
// without a clean quit are pruned by the next start (init).
function finalize(): void {
  if (!sessionFile) return;
  if (lineCount < SMALL_SESSION_MIN_LINES) {
    try {
      unlinkSync(sessionFile);
      console.log('[main] dev session too small, not kept');
    } catch {
      /* already gone */
    }
  }
  sessionFile = '';
}

function init(): void {
  // Packaged builds are production; never create logs folders there.
  if (app.isPackaged) return;
  try {
    const dir = join(app.getAppPath(), 'logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Skip small sessions left behind by an unclean quit before starting ours.
    const pruned = pruneSmallSessionLogs(dir, SMALL_SESSION_MIN_LINES);
    if (pruned.length > 0) {
      console.log(`[main] pruned small session logs: ${pruned.join(', ')}`);
    }
    const now = new Date();
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    sessionFile = join(dir, `session-${stamp}-${process.pid}.log`);
    writeLine('log', [`=== Spirit dev session started ${now.toISOString()} ===`]);
    const removed = rotateLogFiles(dir, MAX_SESSION_LOGS);
    if (removed.length > 0) {
      writeLine('log', [`[main] rotated old session logs: ${removed.join(', ')}`]);
    }
    console.log(`[main] dev session log: ${sessionFile}`);
    app.on('before-quit', finalize);
  } catch {
    sessionFile = '';
  }
}

// Patch console AFTER capturing the originals, so the patched versions still
// surface to the real terminal while also landing in the session file.
const original = { log: console.log, warn: console.warn, error: console.error };

console.log = (...args: unknown[]) => {
  original.log(...args);
  writeLine('log', args);
};
console.warn = (...args: unknown[]) => {
  original.warn(...args);
  writeLine('warn', args);
};
console.error = (...args: unknown[]) => {
  original.error(...args);
  writeLine('error', args);
};

init();

export function getSessionLogPath(): string {
  return sessionFile;
}
