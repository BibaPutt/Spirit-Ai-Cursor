import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordAppLesson } from '../../memory/app-lessons';
import type { ToolDefinition } from './index';

const execFileP = promisify(execFile);
const RUN_TIMEOUT_MS = 15_000;
const OUTPUT_MAX = 4000;

// Commands too dangerous to ever run, even with approval: destructive disk
// ops, shutdown, account/system changes, silent installs. The prompt never
// needs these — their absence costs nothing.
// NOTE: `format` matches ONLY the disk command (`format C:` — drive letter
// required), never PowerShell's `Format-Table`/`Format-List`/`Format-Wide`
// display cmdlets, which are read-only and explicitly allowed.
const DANGEROUS_RE =
  /(^|[\s;|&])(format\s+[a-zA-Z]:|del\s+\/f\s+\/s|rmdir\s+\/s|rd\s+\/s|deltree\b|shutdown\b|reboot\b|taskkill\s+\/f\s+\/im\s+.*(system|lsass|winlogon|explorer)|net\s+user\b|net\s+localgroup\b|net\s+accounts\b|reg\s+(add|delete)\b|diskpart\b|mountvol\b|chkdsk\s+\/[a-z]|sc\s+(config|delete|create)\b|bcdedit\b|disable-windowsdefender|set-mp|\/s\s+.*\be:\s*\\|wmic\s+.*\bdelete\b)/i;

// Pure, testable runner. `shell` is the program that executes the command
// string (cmd on Windows, sh elsewhere). Returns an object the tool turns
// into a message the model can debug from.
export async function runShellCommand(
  command: string,
  shell: string,
  shellArgs: string[],
  timeoutMs = RUN_TIMEOUT_MS,
  maxOutput = OUTPUT_MAX,
): Promise<{ ok: boolean; output: string; command: string }> {
  const clean = command.trim();
  if (!clean) return { ok: false, output: 'Error: empty command.', command };
  if (DANGEROUS_RE.test(clean)) {
    return {
      ok: false,
      output: 'Error: this command was blocked as potentially destructive.',
      command: clean,
    };
  }
  try {
    const { stdout, stderr } = await execFileP(shell, [...shellArgs, clean], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    if (!out) return { ok: true, output: '(no output — command completed)', command: clean };
    return { ok: true, output: out.slice(0, maxOutput), command: clean };
  } catch (err) {
    const e = err as {
      code?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    let detail = '';
    if (e.code === 'ETIMEDOUT' || e.killed) {
      detail = 'Command timed out after ' + timeoutMs + 'ms.';
    } else if (e.code === 'ENOENT') {
      detail = `Command not found: the shell "${shell}" is unavailable.`;
    } else {
      detail = `Exit ${String(e.code ?? 'unknown')}: ${String(e.message ?? '').slice(0, 300)}`;
      const tail = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
      if (tail) detail += '\n' + tail.slice(0, maxOutput);
    }
    return { ok: false, output: `Error: ${detail}`, command: clean };
  }
}

export function platformShell(): { shell: string; args: string[] } {
  // /s is the crucial flag on Windows: it disables cmd's special-character
  // handling so the command string is passed VERBATIM. Without it,
  // `cmd /d /c start "" "C:\Program Files\X\app.exe"` strips the inner quotes
  // and the launch silently fails (the "Spotify never opens" bug). With
  // /d /s /c the quotes survive and the app actually launches.
  if (process.platform === 'win32') return { shell: 'cmd', args: ['/d', '/s', '/c'] };
  return { shell: '/bin/sh', args: ['-c'] };
}

// GUI launchers (`explorer`, `start`, `open`, `xdg-open`) routinely exit
// non-zero even when they succeeded: plain `cmd /c explorer` returns Exit 1
// after Explorer opens, and xdg-open/open detach and report "failure" that is
// really a launch. Node's execFile can't tell "opened fine" from "truly
// failed", so for these launchers an Exit-<code> result (NOT a timeout or
// missing-shell error) is treated as "likely launched" and the model is told
// to VERIFY with ui_read/see_screen instead of giving up. Pure + unit-tested.
export function guiLaunchOutcome(command: string, output: string): { hint: string } | null {
  const token = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!token || !['explorer', 'explorer.exe', 'start', 'open', 'xdg-open'].includes(token)) {
    return null;
  }
  if (!/^Error: Exit \d+/m.test(output)) return null;
  return {
    hint:
      `${token} is a GUI launcher: the OS often reports a non-zero exit code even when the app/folder opened. ` +
      `Treat this as LIKELY LAUNCHED — verify with ui_read() (or see_screen()) whether the window appeared, then continue. ` +
      `Command was: ${command.trim()}`,
  };
}

export const runCommandTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a direct system command in the background and return its output. Prefer this over clicking through UIs when a task can be done with one command: open a file/folder/URL (start <thing> / open <thing> / xdg-open), create files or folders, check disk, etc. Do NOT use this to check whether an app is running — call list_processes instead (tasklist/findstr quoting through cmd is unreliable). The command runs on the user\'s machine and requires their green-button approval. If it fails, read the error and retry with a corrected command or a different approach.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The command to run. On Windows this runs through cmd /c; elsewhere through sh -c. Example commands: Windows: `start Spotify`, `start ms-settings:`, `tasklist`, `mkdir "C:\\Users\\me\\New Folder"`. macOS: `open -a Safari`, `open ~/Documents`, `ps aux`. Linux: `xdg-open https://...`, `ps aux`.',
          },
        },
        required: ['command'],
      },
    },
  },
  uiLabel: (args) => {
    const c = String(args.command ?? '').trim();
    return c ? `Running: ${c.slice(0, 40)}` : 'Running a command';
  },
  async execute(args) {
    const command = String(args.command ?? '').trim();
    if (!command) return 'Error: run_command requires a "command" argument.';
    const { shell, args: shellArgs } = platformShell();
    const res = await runShellCommand(command, shell, shellArgs);
    if (!res.ok) {
      // GUI launchers (explorer/start/open/xdg-open) exit 1 on success —
      // present that as "verify, don't give up" instead of a flat failure.
      const gui = guiLaunchOutcome(command, res.output);
      if (gui) {
        // Per-app lesson: remember this quirk so later Explorer/start launches
        // don't re-trip the same false-failure next session.
        const token = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        recordAppLesson(token, `gui-launch:${token}`, gui.hint);
        return gui.hint;
      }
      // Failure feedback the model can debug from: the exact command, what
      // went wrong, and a hint to retry differently.
      return (
        `${res.output}\n` +
        `Command was: ${res.command}\n` +
        `Try a different approach (different quoting, a different command, or another tool) and call again.`
      );
    }
    return res.output;
  },
};
