import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'spirit-test'),
    getAppPath: () => join(tmpdir(), 'spirit-test'),
    getName: () => 'Spirit',
    getVersion: () => 'test',
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  clipboard: { readText: () => '', writeText: vi.fn(), writeHTML: vi.fn(), readHTML: () => '' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  net: { request: vi.fn() },
}));

import {
  runCommandTool,
  platformShell,
  runShellCommand,
  guiLaunchOutcome,
} from '../electron/llm/tools/run-command';

describe('runShellCommand', () => {
  it('rejects an empty command', async () => {
    const res = await runShellCommand('', 'cmd', ['/c']);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('empty command');
  });

  it('blocks destructive commands before execution', async () => {
    for (const bad of ['format C:', 'format D: /q', 'shutdown /s', 'del /f /s C:\\', 'net user x /add']) {
      const res = await runShellCommand(bad, 'cmd', ['/c']);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('blocked as potentially destructive');
    }
  });

  it('allows read-only PowerShell display cmdlets (Format-Table is not format C:)', async () => {
    const res = await runShellCommand(
      'powershell -NoProfile -Command "Get-Process | Format-Table -AutoSize"',
      'cmd',
      ['/c'],
    );
    // Must not be blocked by the safety filter; it may still fail for other
    // reasons on non-Windows CI (powershell absent) — but never as blocked.
    expect(res.output).not.toContain('blocked as potentially destructive');
  });

  it('allows benign commands and returns their output', async () => {
    const res = await runShellCommand('console.log("hi")', process.execPath, ['-e']);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('hi');
  });

  it('reports non-zero exits with the exit code', async () => {
    const res = await runShellCommand('process.exit(3)', process.execPath, ['-e']);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('3');
  });

  it('reports missing shells as ENOENT', async () => {
    const res = await runShellCommand('echo hi', 'definitely-not-a-shell-xyz', ['-c']);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Command not found');
  });

  it('times out long-running commands', async () => {
    const res = await runShellCommand(
      'setTimeout(() => {}, 5000)',
      process.execPath,
      ['-e'],
      150,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain('timed out');
  });
});

describe('runCommandTool', () => {
  it('declares the run_command function with a command argument', () => {
    expect(runCommandTool.declaration.function.name).toBe('run_command');
    expect(runCommandTool.declaration.function.parameters.required).toContain('command');
  });

  it('returns an error message when command is missing', async () => {
    const res = await runCommandTool.execute({}, {
      latestAssistantText: '',
      originalPrompt: 'x',
      abort: new AbortController().signal,
    } as never);
    expect(res).toContain('Error:');
  });

  it('returns failure feedback that names the exact command for debugging', async () => {
    const res = await runCommandTool.execute({ command: 'format C:' }, {
      latestAssistantText: '',
      originalPrompt: 'x',
      abort: new AbortController().signal,
    } as never);
    expect(res).toContain('Command was: format C:');
    expect(res).toContain('Try a different approach');
  });

  it('labels commands for the activity UI', () => {
    expect(runCommandTool.uiLabel({ command: 'start Spotify' })).toContain('start Spotify');
  });
});

describe('platformShell', () => {
  it('runs cmd verbatim with /s so quoted arguments with spaces survive', () => {
    const { shell, args } = platformShell();
    if (process.platform === 'win32') {
      // /s disables cmd special-char handling: `start "" "C:\Program Files\X\app.exe"`
      // keeps its quotes and the app launches instead of silently failing.
      expect(shell).toBe('cmd');
      expect(args).toEqual(['/d', '/s', '/c']);
    } else {
      expect(shell).toBe('/bin/sh');
      expect(args).toEqual(['-c']);
    }
  });
});

describe('guiLaunchOutcome', () => {
  it('treats exit-code failures of GUI launchers as "likely launched"', () => {
    for (const cmd of ['explorer', 'explorer.exe', 'start Spotify', 'open ~/docs', 'xdg-open https://x']) {
      const hint = guiLaunchOutcome(cmd, 'Error: Exit 1: some Windows message');
      expect(hint).not.toBeNull();
      expect(hint!.hint.toLowerCase()).toContain('verify');
    }
  });

  it('never masks real failures (timeouts, missing shells, non-launcher commands)', () => {
    expect(guiLaunchOutcome('explorer', 'Error: Command not found: the shell is unavailable.')).toBeNull();
    expect(guiLaunchOutcome('xdg-open x', 'Command timed out after 15000ms.')).toBeNull();
    expect(guiLaunchOutcome('echo hi', 'Error: Exit 1: boom')).toBeNull();
    expect(guiLaunchOutcome('', 'Error: Exit 1: boom')).toBeNull();
    expect(guiLaunchOutcome('tasklist', 'Error: Exit 2: boom')).toBeNull();
  });

  it('names the exact command in the hint so the model can verify it', () => {
    const hint = guiLaunchOutcome('explorer', 'Error: Exit 1: x');
    expect(hint!.hint).toContain('Command was: explorer');
  });
});
