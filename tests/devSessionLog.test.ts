import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => hoisted.dir, on: vi.fn() },
}));

describe('dev session log', () => {
  beforeEach(() => {
    hoisted.dir = mkdtempSync(join(tmpdir(), 'spirit-devlog-'));
  });

  afterEach(() => {
    if (hoisted.dir) rmSync(hoisted.dir, { recursive: true, force: true });
  });

  it('creates a logs folder with a session file and captures console lines', async () => {
    const mod = await import('../electron/dev/session-log');
    const logsDir = join(hoisted.dir, 'logs');
    expect(existsSync(logsDir)).toBe(true);
    const files = readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    expect(files).toHaveLength(1);
    expect(mod.getSessionLogPath()).toBe(join(logsDir, files[0]));

    console.log('probe line for session capture');
    const content = readFileSync(join(logsDir, files[0]), 'utf-8');
    expect(content).toContain('Spirit dev session started');
    expect(content).toContain('probe line for session capture');
  });

  it('skips small sessions when pruning (few lines = noise)', async () => {
    const mod = await import('../electron/dev/session-log');
    const dir = mkdtempSync(join(tmpdir(), 'spirit-prune-'));
    try {
      // 5-line session — a quick build/restart, should be dropped.
      const small = join(dir, 'session-20260101-010000-1.log');
      writeFileSync(small, Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n') + '\n');
      // 60-line session — a real one, must survive.
      const big = join(dir, 'session-20260101-020000-2.log');
      writeFileSync(big, Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n');

      const removed = mod.pruneSmallSessionLogs(dir, mod.SMALL_SESSION_MIN_LINES);
      expect(removed).toEqual(['session-20260101-010000-1.log']);
      expect(existsSync(small)).toBe(false);
      expect(existsSync(big)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates old session logs to at most MAX', async () => {
    const mod = await import('../electron/dev/session-log');
    const dir = mkdtempSync(join(tmpdir(), 'spirit-rotate-'));
    try {
      const names = Array.from({ length: 12 }, (_, i) => {
        const stamp = `20260101-0100${String(i).padStart(2, '0')}`;
        return `session-${stamp}-${i}.log`;
      });
      for (const n of names) writeFileSync(join(dir, n), 'x\n'.repeat(50));
      const removed = mod.rotateLogFiles(dir, mod.MAX_SESSION_LOGS);
      expect(removed).toHaveLength(2);
      expect(removed).toEqual(expect.arrayContaining([names[0], names[1]]));
      const remaining = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
      expect(remaining).toEqual(names.slice(2).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
