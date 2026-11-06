// Foreground-window capture/restore around tool approvals.
//
// Clicking an approval button in the Spirit GUI moves OS focus to Spirit's
// window. When the approved tool then synthesizes input (press_key, type_text,
// click, ...) the keystrokes land in Spirit instead of the user's target app
// (Notepad, etc.). We capture the foreground window BEFORE the approval UI is
// shown and restore it AFTER approval, right before the tool executes, so every
// input task targets the app the user was working in.
//
// The captured value is opaque and platform-shaped: Windows returns the decimal
// HWND, macOS the frontmost app's PID, Linux the X11 window id — callers just
// round-trip it back to restoreForeground.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';
import { runPowerShell } from '../capture/ps-worker';

const execFileP = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Snapshot the current foreground window for later restore. Returns null on
// unsupported platforms or when no foreground window could be read.
export async function captureForeground(): Promise<number | null> {
  if (process.platform === 'win32') {
    try {
      const out = await runPowerShell('[SpiritFG.Native]::GetForegroundWindow()', 3000);
      const hwnd = parseInt(out, 10);
      return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP(
        'osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          `
ObjC.import('AppKit');
const app = $.NSWorkspace.sharedApplication.frontmostApplication;
JSON.stringify(Number(app.processIdentifier));
`,
        ],
        { timeout: 3000, windowsHide: true },
      );
      const pid = Number(stdout.trim());
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileP('xdotool', ['getactivewindow'], {
        timeout: 3000,
        windowsHide: true,
      });
      const id = parseInt(stdout.trim(), 10);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Bring a previously captured window back to the foreground so synthesized
// input lands there. Best-effort: never throws.
export async function restoreForeground(hwnd: number | null): Promise<void> {
  if (!hwnd) return;
  try {
    if (process.platform === 'win32') {
      const script = `
$target = ${hwnd}
[SpiritFG.Native]::ShowWindow($target, 9) | Out-Null
$fg = [SpiritFG.Native]::GetForegroundWindow()
$dummy = 0
$fgThread = [SpiritFG.Native]::GetWindowThreadProcessId($fg, [ref]$dummy)
$myThread = [SpiritFG.Native]::GetCurrentThreadId()
if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null }
[SpiritFG.Native]::SetForegroundWindow($target) | Out-Null
if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }
`;
      await runPowerShell(script, 3000);
    } else if (process.platform === 'darwin') {
      // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps.
      await execFileP(
        'osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          `
ObjC.import('AppKit');
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${hwnd});
if (app) app.activateWithOptions(3);
`,
        ],
        { timeout: 3000, windowsHide: true },
      );
    } else if (process.platform === 'linux') {
      const id = String(hwnd);
      // windowactivate needs an EWMH-compliant WM; windowfocus (XSetInputFocus)
      // works everywhere — try activate, fall back to focus-only.
      try {
        await execFileP('xdotool', ['windowactivate', id], { timeout: 3000, windowsHide: true });
      } catch {
        await execFileP('xdotool', ['windowfocus', id], { timeout: 3000, windowsHide: true });
      }
    }
    // Let focus settle before synthesizing input.
    await sleep(120);
  } catch {
    /* best-effort focus; input synthesis continues regardless */
  }
}

// Force an overlay BrowserWindow to the foreground on Windows using the
// AttachThreadInput trick. Plain SetForegroundWindow is silently rejected when
// the calling process doesn't hold foreground rights (which is always the case
// when focus is triggered from a global keyboard hook). The trick: temporarily
// attach to the current foreground window's thread, call SetForegroundWindow,
// then detach. This satisfies Windows' foreground-rights check.
//
// On macOS/Linux this is a no-op — Electron's BrowserWindow.focus() works
// there.
export async function focusOverlayWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  if (process.platform === 'win32') {
    try {
      const hwndBuf = win.getNativeWindowHandle();
      // getNativeWindowHandle returns a Buffer; interpret as uint32 HWND.
      const hwnd = hwndBuf.readUInt32LE(0);
      const script = `
$hwnd = ${hwnd}
$fg = [SpiritFG.Native]::GetForegroundWindow()
$dummy = 0
$fgThread = [SpiritFG.Native]::GetWindowThreadProcessId($fg, [ref]$dummy)
$myThread = [SpiritFG.Native]::GetCurrentThreadId()
if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null }
[SpiritFG.Native]::SetForegroundWindow($hwnd) | Out-Null
if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }
`;
      await runPowerShell(script, 2000);
    } catch {
      /* best-effort */
    }
  }
  try {
    win.focus();
    win.webContents.focus();
  } catch {
    /* best-effort */
  }
}
