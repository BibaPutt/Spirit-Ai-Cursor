import { describe, expect, it } from 'vitest';
import {
  filterNames,
  listProcesses,
  listProcessesTool,
  parsePsComms,
  parseTasklistCsv,
} from '../electron/llm/tools/list-processes';

const TASKLIST = [
  '"Image Name","PID","Session Name","Session#","Mem Usage"',
  '"System Idle Process","0","Services","0","8 K"',
  '"Code.exe","1234","Console","1","200,000 K"',
  '"code.exe","1235","Console","1","10,000 K"',
  '"notepad.exe","42","Console","1","5,000 K"',
  '',
].join('\r\n');

describe('parseTasklistCsv', () => {
  it('extracts unique sorted names, skips the header', () => {
    expect(parseTasklistCsv(TASKLIST)).toEqual([
      'Code.exe',
      'code.exe',
      'notepad.exe',
      'System Idle Process',
    ]);
  });

  it('returns [] on garbage', () => {
    expect(parseTasklistCsv('nope\nstill nope')).toEqual([]);
  });
});

describe('parsePsComms', () => {
  it('takes basenames and drops blanks', () => {
    expect(parsePsComms('  /usr/bin/code\n\nnotepad\n-login\n')).toEqual([
      'code',
      'login',
      'notepad',
    ]);
  });
});

describe('filterNames', () => {
  it('matches case-insensitively, empty matches all', () => {
    const names = ['Code.exe', 'notepad.exe'];
    expect(filterNames(names, 'code')).toEqual(['Code.exe']);
    expect(filterNames(names, '')).toEqual(names);
  });
});

describe('listProcesses', () => {
  it('runs tasklist without a shell on Windows', async () => {
    const seen: Array<{ file: string; args: string[] }> = [];
    const names = await listProcesses('win32', 'code', async (file, args) => {
      seen.push({ file, args });
      return { stdout: TASKLIST, stderr: '' };
    });
    expect(seen).toEqual([{ file: 'tasklist', args: ['/FO', 'CSV', '/NH'] }]);
    expect(names).toEqual(['Code.exe', 'code.exe']);
  });

  it('runs ps on posix', async () => {
    const names = await listProcesses('linux', '', async () => ({
      stdout: 'code\nchrome\n',
      stderr: '',
    }));
    expect(names).toEqual(['chrome', 'code']);
  });

  it('surfaces exec failures as data, never throws', async () => {
    await expect(
      listProcesses('win32', '', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
  });
});

describe('listProcessesTool', () => {
  it('is named and described for process checks', () => {
    expect(listProcessesTool.declaration.function.name).toBe('list_processes');
    expect(listProcessesTool.declaration.function.description).toMatch(/running/i);
    expect(listProcessesTool.uiLabel({ match: 'code' })).toContain('code');
  });
});
