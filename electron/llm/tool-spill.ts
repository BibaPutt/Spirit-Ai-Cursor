import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tool-result truncation with spill files (opencode-style Truncate.output).
// Long tool outputs blow the context window mid-run; instead of dropping the
// tail silently, the full text lands in the OS temp dir and the conversation
// keeps a capped head plus a pointer the model can read back with read_file.
// Temp, not <workspace>/.spirit/spills: spills hold raw tool output (file
// reads, clipboard, OCR) that must not accumulate in the user's Documents,
// and the OS reclaims temp on reboot. Stale files are swept opportunistically
// (at most hourly) so nothing lives past a day. Pure formatting is
// unit-tested; only spillToFile touches disk and it never throws (worst
// case: plain truncation).

export const SPILL_HEAD_CHARS = 4000;
export const SPILL_TRIGGER_CHARS = 6000;

const SPILL_DIR = join(tmpdir(), 'spirit-spills');
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
const SPILL_SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;
let lastSpillSweepAt = 0;

function sweepStaleSpills(): void {
  const now = Date.now();
  if (now - lastSpillSweepAt < SPILL_SWEEP_MIN_INTERVAL_MS) return;
  lastSpillSweepAt = now;
  try {
    for (const name of readdirSync(SPILL_DIR)) {
      const p = join(SPILL_DIR, name);
      try {
        if (now - statSync(p).mtimeMs > SPILL_TTL_MS) rmSync(p, { force: true });
      } catch {
        /* per-file races are fine */
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}

export function safeToolFilename(toolName: string, callId: string): string {
  const clean = `${toolName}-${callId}`.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  return `${clean || 'tool'}.txt`;
}

export function spillPointerText(spillPath: string, totalChars: number): string {
  return (
    `\n…[output truncated at ${SPILL_HEAD_CHARS} of ${totalChars} chars — ` +
    `full output saved to ${spillPath}; read it back with read_file in chunks if you need more]`
  );
}

export function spillToolOutput(
  toolName: string,
  callId: string,
  text: string,
): { content: string; spilledPath: string | null } {
  if (text.length <= SPILL_TRIGGER_CHARS) return { content: text, spilledPath: null };
  const head = text.slice(0, SPILL_HEAD_CHARS);
  try {
    mkdirSync(SPILL_DIR, { recursive: true });
    sweepStaleSpills();
    const file = join(SPILL_DIR, safeToolFilename(toolName, callId));
    writeFileSync(file, text, 'utf-8');
    return { content: head + spillPointerText(file, text.length), spilledPath: file };
  } catch {
    return { content: head + `\n…[truncated at ${SPILL_HEAD_CHARS} of ${text.length} chars]`, spilledPath: null };
  }
}

// Doom-loop signature: stable name+args key. Counts the trailing run of
// identical calls (including the upcoming one).
export function toolCallSignature(name: string, args: unknown): string {
  let argText = '';
  try {
    argText = JSON.stringify(args ?? null);
  } catch {
    argText = String(args);
  }
  return `${name}::${argText}`;
}

// How many times in a row this exact call has now run (upcoming included).
// Warn at 5, stop at 8 — the model gets told both thresholds so it can
// course-correct before the hard stop.
export const DOOM_WARN_AT = 5;
export const DOOM_STOP_AT = 8;

export function identicalStreak(recentSignatures: string[], nextSignature: string): number {
  let streak = 1;
  for (let i = recentSignatures.length - 1; i >= 0; i--) {
    if (recentSignatures[i] !== nextSignature) break;
    streak++;
  }
  return streak;
}

export function isDoomLoop(recentSignatures: string[], nextSignature: string, threshold = DOOM_STOP_AT): boolean {
  return identicalStreak(recentSignatures, nextSignature) >= threshold;
}
