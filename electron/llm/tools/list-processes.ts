import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from './index';

const execFileP = promisify(execFile);
const LIST_TIMEOUT_MS = 10_000;
const MAX_NAMES = 300;

// Read-only process list: "is app X running?" without shell quoting games.
// Runs tasklist / ps DIRECTLY via execFile argv (no cmd/sh in between), so
// quoted multi-word filters can never break like `findstr "a b c"` does
// through cmd /c. Read-only → no approval required.

export function parseTasklistCsv(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*"([^"]+)"/);
    if (!m?.[1]) continue;
    // Skip the /NH-less header row when present ("Image Name",...).
    if (/^image name$/i.test(m[1].trim())) continue;
    names.push(m[1]);
  }
  return uniqueSorted(names);
}

export function parsePsComms(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const base = t.split('/').pop() ?? t;
    // ps comm can prefix "-" for login shells; drop it.
    names.push(base.replace(/^-/, ''));
  }
  return uniqueSorted(names);
}

function uniqueSorted(names: string[]): string[] {
  return Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
}

export function filterNames(names: string[], match: string): string[] {
  const q = match.trim().toLowerCase();
  if (!q) return names;
  return names.filter((n) => n.toLowerCase().includes(q));
}

type ExecFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args) =>
  execFileP(file, args, { timeout: LIST_TIMEOUT_MS, windowsHide: true }) as Promise<{
    stdout: string;
    stderr: string;
  }>;

// Injectable runner so tests drive the parsing without spawning processes.
export async function listProcesses(
  platform: NodeJS.Platform = process.platform,
  match = '',
  exec: ExecFn = defaultExec,
): Promise<string[]> {
  const raw =
    platform === 'win32'
      ? await exec('tasklist', ['/FO', 'CSV', '/NH'])
      : await exec('/bin/ps', ['-eo', 'comm=']);
  const names = platform === 'win32' ? parseTasklistCsv(raw.stdout) : parsePsComms(raw.stdout);
  return filterNames(names, match).slice(0, MAX_NAMES);
}

export const listProcessesTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'list_processes',
      description:
        'List currently running process names (e.g. Code.exe, notepad.exe, chrome). Use this — not run_command with tasklist/findstr/ps — whenever you need to know whether an app is running. Optional "match" filters case-insensitively (e.g. {"match":"code"}). Read-only, no quoting pitfalls.',
      parameters: {
        type: 'object',
        properties: {
          match: {
            type: 'string',
            description: 'Optional substring filter, e.g. "code", "notepad". Empty lists everything.',
          },
        },
      },
    },
  },
  uiLabel: (args) => {
    const m = String(args.match ?? '').trim();
    return m ? `Checking for "${m.slice(0, 24)}" processes` : 'Listing processes';
  },
  async execute(args) {
    try {
      const match = typeof args.match === 'string' ? args.match : '';
      const names = await listProcesses(process.platform, match);
      if (names.length === 0) {
        return match
          ? `No running process matches "${match.trim()}".`
          : 'No running processes found.';
      }
      const shown = names.slice(0, 120).join(', ');
      const more = names.length > 120 ? ` (+${names.length - 120} more)` : '';
      return `Running processes (${names.length}): ${shown}${more}`;
    } catch (err) {
      return `Error: could not list processes (${err instanceof Error ? err.message : String(err)}).`;
    }
  },
};
