// Desktop input synthesis — the "type / click / shortcut" action engine,
// ported from the Python spirit-aicursor OSController.
//
// Two mechanisms are used:
//  - Keyboard (shortcuts + typing): uiohook-napi's `keyTap`. Text is typed
//    via the clipboard paste shortcut (write → Ctrl/Cmd+V → restore), which
//    is fast and handles every character including code — the same strategy
//    the Python spirit's `_paste` used.
//  - Mouse: uiohook only synthesizes keys, so clicks/moves go through the
//    OS accessibility/native bridge per platform (PowerShell+user32 on
//    Windows, CoreGraphics via osascript on macOS, xdotool on Linux).
//
// Before synthesizing input we blur every overlay window so keystrokes land
// in the user's focused app (Notepad etc.) and not in Spirit's own prompt
// input.

import { clipboard } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { isGlobalHookStarted, startGlobalHook } from './global-hook';
import { pasteComboForPlatform } from './paste-combo';
import { getAllOverlays, overrideAllOverlaysClickThrough } from '../windows/overlay';
import { runPowerShell } from '../capture/ps-worker';
import { getSpiritWindowHandles } from '../capture/spirit-windows';
import { beginForward, endForward } from './forward-tracker';

const execFileP = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Drop keyboard focus from the overlay windows so synthesized input reaches
// the user's app underneath instead of Spirit's own prompt box.
export function releaseOverlayFocus(): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) {
      try {
        win.blur();
      } catch {
        /* ignore */
      }
    }
  }
}

async function ensureHook(): Promise<void> {
  if (!isGlobalHookStarted()) startGlobalHook();
  // Give the native hook a moment to attach before posting events.
  await sleep(30);
}

const NAMED_KEYS: Record<string, number> = {
  enter: UiohookKey.Enter,
  return: UiohookKey.Enter,
  tab: UiohookKey.Tab,
  escape: UiohookKey.Escape,
  esc: UiohookKey.Escape,
  space: UiohookKey.Space,
  spacebar: UiohookKey.Space,
  backspace: UiohookKey.Backspace,
  delete: UiohookKey.Delete,
  del: UiohookKey.Delete,
  home: UiohookKey.Home,
  end: UiohookKey.End,
  pageup: UiohookKey.PageUp,
  pagedown: UiohookKey.PageDown,
  insert: UiohookKey.Insert,
  up: UiohookKey.ArrowUp,
  arrowup: UiohookKey.ArrowUp,
  down: UiohookKey.ArrowDown,
  arrowdown: UiohookKey.ArrowDown,
  left: UiohookKey.ArrowLeft,
  arrowleft: UiohookKey.ArrowLeft,
  right: UiohookKey.ArrowRight,
  arrowright: UiohookKey.ArrowRight,
  semicolon: UiohookKey.Semicolon,
  equal: UiohookKey.Equal,
  comma: UiohookKey.Comma,
  minus: UiohookKey.Minus,
  period: UiohookKey.Period,
  slash: UiohookKey.Slash,
  backquote: UiohookKey.Backquote,
  bracketleft: UiohookKey.BracketLeft,
  backslash: UiohookKey.Backslash,
  bracketright: UiohookKey.BracketRight,
  quote: UiohookKey.Quote,
  ctrl: UiohookKey.Ctrl,
  control: UiohookKey.Ctrl,
  alt: UiohookKey.Alt,
  option: UiohookKey.Alt,
  shift: UiohookKey.Shift,
  meta: UiohookKey.Meta,
  cmd: UiohookKey.Meta,
  command: UiohookKey.Meta,
  win: UiohookKey.Meta,
  super: UiohookKey.Meta,
};

function resolveKeyName(name: string): number | undefined {
  const lower = name.toLowerCase();
  if (NAMED_KEYS[lower] !== undefined) return NAMED_KEYS[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(name)) {
    const code = UiohookKey[('F' + name.slice(1)) as keyof typeof UiohookKey];
    if (typeof code === 'number') return code;
  }
  if (name.length === 1) {
    if (/[a-z]/i.test(name)) return UiohookKey[name.toUpperCase() as keyof typeof UiohookKey];
    if (/[0-9]/.test(name)) return UiohookKey[name as keyof typeof UiohookKey];
  }
  return undefined;
}

// Parse "ctrl+n", "ctrl+shift+s", "alt+f4", "enter" into { key, modifiers }.
export function parseKeyCombo(
  combo: string,
): { key: number; modifiers: number[] } | { error: string } {
  const parts = combo
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return { error: 'empty key combo' };
  const modifiers: number[] = [];
  let main = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') modifiers.push(UiohookKey.Ctrl);
    else if (part === 'alt' || part === 'option') modifiers.push(UiohookKey.Alt);
    else if (part === 'shift') modifiers.push(UiohookKey.Shift);
    else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'win' || part === 'super') {
      modifiers.push(UiohookKey.Meta);
    } else if (!main) {
      main = part;
    } else {
      return { error: `too many keys in "${combo}"` };
    }
  }
  if (!main) {
    // Bare modifier (e.g. just "shift") — tap it alone.
    const modKey = modifiers.shift();
    if (modKey === undefined) return { error: 'empty key combo' };
    return { key: modKey, modifiers: [] };
  }
  const key = resolveKeyName(main);
  if (key === undefined) return { error: `unknown key "${main}"` };
  return { key, modifiers };
}

export async function pressKey(combo: string, times = 1): Promise<string> {
  const parsed = parseKeyCombo(combo);
  if ('error' in parsed) return parsed.error;
  await ensureHook();
  releaseOverlayFocus();
  for (let i = 0; i < times; i++) {
    uIOhook.keyTap(parsed.key, parsed.modifiers);
    await sleep(40);
  }
  return 'ok';
}

// The paste shortcut for the current platform (Cmd+V on macOS, Ctrl+V
// elsewhere), shared with paste_image/paste_table so mac synthesis actually
// pastes. Defined in ./paste-combo (dependency-free, unit-tested).
export { pasteComboForPlatform };

// Serialize type_text executions. The implementation clobbers the clipboard
// (write text → paste → restore previous), and two interleaved calls race:
// the restore of one can overwrite the paste of the other, or a paste lands
// the wrong text. Each call runs to completion before the next starts.
let typeTextQueue: Promise<void> = Promise.resolve();

export async function typeText(text: string): Promise<void> {
  const task = typeTextQueue.then(() => typeTextOnce(text));
  typeTextQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

// Type arbitrary text into the focused window via clipboard paste, then
// restore the user's previous clipboard text if there was any.
async function typeTextOnce(text: string): Promise<void> {
  await ensureHook();
  releaseOverlayFocus();
  const previous = clipboard.readText();
  clipboard.writeText(text);
  await sleep(80);
  await pressKey(pasteComboForPlatform());
  // Let the paste land before restoring the clipboard.
  await sleep(200);
  if (previous) {
    try {
      clipboard.writeText(previous);
    } catch {
      /* ignore */
    }
  }
}

// Mouse synthesis — platform bridge

async function runCommand(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileP(cmd, args, { timeout: 20000, windowsHide: true });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

const sleepBetweenActions = () => sleep(120);

async function windowsMouse(
  script: (sx: number, sy: number) => string,
  x: number,
  y: number,
): Promise<{ ok: boolean; error?: string; output?: string }> {
  const body = script(Math.round(x), Math.round(y));
  // Runs in the persistent PowerShell worker (warm process, C# already
  // compiled after the first call), so a synthesized click costs ~10-40ms
  // instead of a ~1s fresh spawn + recompile. That matters a lot in capture
  // mode: the overlay is click-through for the duration of the synthesis and
  // the OS briefly draws the app's cursor during that window — a 30ms blip is
  // imperceptible, a 1s flash is the "cursor flashes when I click" bug.
  const full = `
if (-not ('Spirit.Mouse' -as [type])) {
  Add-Type -Namespace Spirit -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, System.UIntPtr extra);
'@
}
${body}
`;
  try {
    const out = await runPowerShell(full, 15000);
    return { ok: true, output: String(out ?? '').trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const WIN_MOVE = (x: number, y: number) => `[Spirit.Mouse]::SetCursorPos(${x}, ${y})`;
const WIN_LEFT_DOWN = `[Spirit.Mouse]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)`;
const WIN_LEFT_UP = `[Spirit.Mouse]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)`;
const WIN_RIGHT_DOWN = `[Spirit.Mouse]::mouse_event(0x0008, 0, 0, 0, [System.UIntPtr]::Zero)`;
const WIN_RIGHT_UP = `[Spirit.Mouse]::mouse_event(0x0010, 0, 0, 0, [System.UIntPtr]::Zero)`;

async function macMouse(
  body: (x: number, y: number) => string,
  x: number,
  y: number,
): Promise<{ ok: boolean; error?: string }> {
  const script = `
ObjC.import('CoreGraphics');
const mk = (type, x, y) => {
  const e = $.CGEventCreateMouseEvent($.CGEventCreate(null), type, $.CGPointMake(x, y), $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, e);
};
${body(Math.round(x), Math.round(y))}
`;
  return runCommand('osascript', ['-l', 'JavaScript', '-e', script]);
}

const MAC_MOVE = (x: number, y: number) =>
  `mk($.kCGEventMouseMoved, ${x}, ${y}); ObjC.import('Foundation'); $.NSThread.sleepForTimeInterval(0.08);`;
const MAC_LEFT_DOWN = (x: number, y: number) =>
  `mk($.kCGEventLeftMouseDown, ${x}, ${y}); ObjC.import('Foundation'); $.NSThread.sleepForTimeInterval(0.05);`;
const MAC_LEFT_UP = (x: number, y: number) =>
  `mk($.kCGEventLeftMouseUp, ${x}, ${y}); ObjC.import('Foundation'); $.NSThread.sleepForTimeInterval(0.05);`;

export async function moveMouse(x: number, y: number): Promise<void> {
  releaseOverlayFocus();
  if (process.platform === 'darwin') {
    await macMouse(MAC_MOVE, x, y);
  } else if (process.platform === 'win32') {
    await windowsMouse(WIN_MOVE, x, y);
  } else {
    await runCommand('xdotool', ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))]);
  }
  await sleepBetweenActions();
}

// While AI mode is active the overlay owns the mouse full-time (custom cursor
// capture mode), so a synthesized click/wheel would land back on our own
// overlay instead of the app underneath. Temporarily drop the overlays to
// click-through for the duration of the synthesis, then restore — otherwise
// LLM tool clicks and forwarded outside-clicks would silently hit Spirit.
async function withOverlaysClickThrough<T>(fn: () => Promise<T>): Promise<T> {
  overrideAllOverlaysClickThrough(true);
  try {
    return await fn();
  } finally {
    overrideAllOverlaysClickThrough(false);
  }
}

export async function clickAt(
  x: number,
  y: number,
  opts: { double?: boolean; button?: 'left' | 'right' } = {},
): Promise<void> {
  // Account the synthetic echoes we're about to post so trigger.ts can tell
  // them apart from a physical second click that gets swallowed by the
  // temporary click-through window (see forward-tracker.ts).
  beginForward(opts.double === true ? 2 : 1);
  try {
    releaseOverlayFocus();
    await withOverlaysClickThrough(async () => {
    const double = opts.double === true;
    if (process.platform === 'darwin') {
      await macMouse((cx, cy) => {
        const base = `${MAC_MOVE(cx, cy)}${MAC_LEFT_DOWN(cx, cy)}${MAC_LEFT_UP(cx, cy)}`;
        return double ? `${base}${MAC_LEFT_DOWN(cx, cy)}${MAC_LEFT_UP(cx, cy)}` : base;
      }, x, y);
    } else if (process.platform === 'win32') {
      const right = opts.button === 'right';
      // console.log(`[forward-click] synthesizing ${right ? 'right' : 'left'} click at ${x},${y}`);
      await windowsMouse((cx, cy) => {
        const down = right ? WIN_RIGHT_DOWN : WIN_LEFT_DOWN;
        const up = right ? WIN_RIGHT_UP : WIN_LEFT_UP;
        // Each segment must be separated by ';' (or a newline) — PowerShell
        // rejects bare method-call concatenation ("Array index expression is
        // missing or not valid"). Without the separators every Windows click
        // synthesis silently failed, so click-through/forwarding never reached
        // the app below.
        const click = `${WIN_MOVE(cx, cy)}; ${down}; Start-Sleep -Milliseconds 40; ${up}`;
        return double ? `${click}; Start-Sleep -Milliseconds 60; ${click}` : click;
      }, x, y);
    } else {
      await runCommand('xdotool', [
        'mousemove',
        '--sync',
        String(Math.round(x)),
        String(Math.round(y)),
        'click',
        opts.button === 'right' ? '3' : double ? '--repeat' : '1',
        ...(double ? ['2', '1'] : []),
      ]);
    }
  });
  await sleepBetweenActions();
  } finally {
    endForward();
  }
}

// Press-drag-release: move to (fromX, fromY), press the left button, move
// through N interpolated steps to (toX, toY), then release. Used by the `drag`
// tool for moving files, selecting text/ranges and resizing. Runs in the same
// persistent PowerShell worker as clicks, so a 20-step drag is still fast.
export async function drag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps = 20,
): Promise<void> {
  releaseOverlayFocus();
  await withOverlaysClickThrough(async () => {
    const n = Math.max(1, Math.min(100, Math.floor(steps) || 20));
    if (process.platform === 'darwin') {
      await macMouse((_x, _y) => {
        let script = `${MAC_MOVE(fromX, fromY)}${MAC_LEFT_DOWN(fromX, fromY)}`;
        for (let i = 1; i <= n; i++) {
          const px = Math.round(fromX + ((toX - fromX) * i) / n);
          const py = Math.round(fromY + ((toY - fromY) * i) / n);
          script += MAC_MOVE(px, py);
        }
        script += MAC_LEFT_UP(toX, toY);
        return script;
      }, toX, toY);
    } else if (process.platform === 'win32') {
      await windowsMouse((_x, _y) => {
        const parts: string[] = [
          `${WIN_MOVE(fromX, fromY)};`,
          'Start-Sleep -Milliseconds 60;',
          `${WIN_LEFT_DOWN};`,
          'Start-Sleep -Milliseconds 60;',
        ];
        for (let i = 1; i <= n; i++) {
          const px = Math.round(fromX + ((toX - fromX) * i) / n);
          const py = Math.round(fromY + ((toY - fromY) * i) / n);
          parts.push(`${WIN_MOVE(px, py)};`);
          parts.push('Start-Sleep -Milliseconds 15;');
        }
        parts.push('Start-Sleep -Milliseconds 60;');
        parts.push(`${WIN_LEFT_UP};`);
        return parts.join('');
      }, toX, toY);
    } else {
      await runCommand('xdotool', ['mousemove', '--sync', String(Math.round(fromX)), String(Math.round(fromY))]);
      await runCommand('xdotool', ['mousedown', '1']);
      for (let i = 1; i <= n; i++) {
        const px = Math.round(fromX + ((toX - fromX) * i) / n);
        const py = Math.round(fromY + ((toY - fromY) * i) / n);
        await runCommand('xdotool', ['mousemove', '--sync', String(px), String(py)]);
      }
      await runCommand('xdotool', ['mouseup', '1']);
    }
  });
  await sleepBetweenActions();
}

export async function scrollLines(delta: number): Promise<void> {
  releaseOverlayFocus();
  const notches = Math.round(delta);
  if (notches === 0) return;
  if (process.platform === 'win32') {
    // WM_MOUSEWHEEL posted by mouse_event is routed by Windows to the
    // FOREGROUND/focus window — NOT to the window under the cursor (the
    // under-cursor redirect only fires when the focused window and the
    // window under the pointer belong to different processes). With Spirit's
    // always-on-top overlay interactive, that synthesized wheel lands on the
    // overlay or on the foreground app instead of the app the cursor is over
    // — the "scroll works in the terminal but not in the browser" bug (the
    // terminal stays foreground; the browser sits behind it). Post the wheel
    // DIRECTLY to the window under the cursor, walking the z-order past
    // Spirit's own overlays (same walk the cursor-shape probe uses), so the
    // target is deterministic regardless of which app has focus.
    //
    // The overlay stays interactive for the whole call (no click-through
    // window): the wheel bypasses it by going straight to the target HWND,
    // and a pass-through window would only double-scroll.
    //
    // Finding the target is the tricky part. WindowFromPoint over the
    // interactive overlay returns the overlay itself; the original sibling
    // walk (GW_HWNDNEXT from its GA_ROOT) then stopped at the FIRST window
    // below it — which is the invisible TSF ghost (class "MSCTFIME UI"/"IME",
    // zero-sized, topmost, above every app), so the wheel went to a 0x0
    // message window that discards it (observed: a CONSTANT target HWND
    // regardless of which app the cursor was over — "scroll works in the
    // terminal, not in the browser"). The fix: walk the true z-order down
    // from the overlay but only STOP at a window that is visible, not a
    // ghost, and whose rect actually CONTAINS the cursor point. The ghosts
    // are 0x0 so they never contain it and get skipped naturally; the first
    // real window that contains the point is what's genuinely under the
    // cursor.
    const skipList = getSpiritWindowHandles().join(', ');
    const electronPid = process.pid;
    const amount = Math.max(-3600, Math.min(3600, notches * 120));
    const body = `
if (-not ('Spirit.Wheel2' -as [type])) {
  Add-Type -Namespace Spirit -Name Wheel2 -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern short GetKeyState(int nVirtKey);
[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
'@
}
$GA_ROOT = 2
$GW_HWNDNEXT = 2
$WM_MOUSEWHEEL = 0x020A
$skips = @(${skipList})
$spiritPid = [int]${electronPid}
$pt = New-Object 'Spirit.Wheel2+POINT'
[Spirit.Wheel2]::GetCursorPos([ref]$pt) | Out-Null
$hwnd = [Spirit.Wheel2]::WindowFromPoint($pt)
if ($hwnd -ne [IntPtr]::Zero) {
  $hwnd = [Spirit.Wheel2]::GetAncestor($hwnd, $GA_ROOT)
}
$target = [IntPtr]::Zero
for ($i = 0; $i -lt 64 -and $hwnd -ne [IntPtr]::Zero; $i++) {
  $skipThis = $false
  $wpid = 0
  [Spirit.Wheel2]::GetWindowThreadProcessId($hwnd, [ref]$wpid) | Out-Null
  if ($wpid -eq $spiritPid) { $skipThis = $true }
  if (-not $skipThis -and ($skips -contains $hwnd.ToInt64())) { $skipThis = $true }
  if (-not $skipThis -and -not [Spirit.Wheel2]::IsWindowVisible($hwnd)) { $skipThis = $true }
  if (-not $skipThis -and [Spirit.Wheel2]::IsIconic($hwnd)) { $skipThis = $true }
  if (-not $skipThis) {
    $cls = New-Object System.Text.StringBuilder 256
    [Spirit.Wheel2]::GetClassName($hwnd, $cls, 256) | Out-Null
    $cn = $cls.ToString()
    if ($cn -eq 'MSCTFIME UI' -or $cn -eq 'IME' -or $cn -eq 'PseudoConsoleWindow') { $skipThis = $true }
  }
  if (-not $skipThis) {
    $r = New-Object 'Spirit.Wheel2+RECT'
    [Spirit.Wheel2]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    if (($r.R -le $r.L) -or ($r.B -le $r.T)) { $skipThis = $true }
    if (-not $skipThis) {
      $contains = ($pt.X -ge $r.L) -and ($pt.X -lt $r.R) -and ($pt.Y -ge $r.T) -and ($pt.Y -lt $r.B)
      if ($contains) { $target = $hwnd; break }
    }
  }
  $hwnd = [Spirit.Wheel2]::GetWindow($hwnd, $GW_HWNDNEXT)
}
# $target is the TOP-LEVEL window under the cursor. Posting the wheel to the
# top level works for classic apps and for WinUI apps whose host handles the
# wheel (WindowsTerminal's CASCADIA_HOSTING_WINDOW_CLASS), but NOT for WinUI
# hosts that merely FRAME native content: Arc's WinUIDesktopWin32WindowClass
# ignores the wheel because its page is rendered by a Chromium child window.
# Descend: among the target's descendants, post to the topmost non-transparent
# Chromium content window (Chrome_WidgetWin_1 / Chrome_RenderWidgetHostHWND)
# that contains the cursor. Chromium's frame HWND processes WM_MOUSEWHEEL and
# routes it to the renderer. For everything else the top-level is the target.
if ($target -ne [IntPtr]::Zero) {
  $content = $target
  $kids = New-Object 'System.Collections.ArrayList'
  $cb = [Spirit.Wheel2+EnumChildProc]{
    param($h, $l)
    [void]$kids.Add($h)
    return $true
  }
  [Spirit.Wheel2]::EnumChildWindows($target, $cb, [IntPtr]::Zero) | Out-Null
  foreach ($k in $kids) {
    $kp = [IntPtr]$k
    if (-not [Spirit.Wheel2]::IsWindowVisible($kp)) { continue }
    $kEx = [Spirit.Wheel2]::GetWindowLongPtr($kp, -20).ToInt64()
    if (($kEx -band 0x20) -ne 0) { continue }
    $kr = New-Object 'Spirit.Wheel2+RECT'
    [Spirit.Wheel2]::GetWindowRect($kp, [ref]$kr) | Out-Null
    if (($kr.R -le $kr.L) -or ($kr.B -le $kr.T)) { continue }
    if (-not (($pt.X -ge $kr.L) -and ($pt.X -lt $kr.R) -and ($pt.Y -ge $kr.T) -and ($pt.Y -lt $kr.B))) { continue }
    $kc = New-Object System.Text.StringBuilder 256
    [Spirit.Wheel2]::GetClassName($kp, $kc, 256) | Out-Null
    if ($kc.ToString().StartsWith('Chrome_')) { $content = $kp; break }
  }
  $target = $content
}
$delta = ${amount}
if ($target -eq [IntPtr]::Zero) {
  # No usable window under the cursor — fall back to routing by cursor position.
  [Spirit.Mouse]::mouse_event(0x0800, 0, 0, $delta, [System.UIntPtr]::Zero)
  Write-Output ('SCROLL target=0 fallback delta=' + $delta)
} else {
  $ctrl = [Spirit.Wheel2]::GetKeyState(0x11) -lt 0
  $keystate = 0
  if ($ctrl) { $keystate = 0x0008 }
  $d = [int]($delta -band 0xFFFF)
  $wParam = [System.IntPtr](([int64]$d -shl 16) -bor $keystate)
  $lParam = [System.IntPtr](([int64](($pt.Y -band 0xFFFF)) -shl 16) -bor ($pt.X -band 0xFFFF))
  $result = [IntPtr]::Zero
  $sent = [Spirit.Wheel2]::SendMessageTimeout($target, $WM_MOUSEWHEEL, $wParam, $lParam, 2, 100, [ref]$result)
  Write-Output ('SCROLL target=' + $target.ToInt64() + ' sent=' + $sent + ' delta=' + $delta + ' at=' + $pt.X + ',' + $pt.Y)
}
`;
    const res = await windowsMouse(() => body, 0, 0);
    // console.log(
    //   `[forward-scroll] ${res.output ?? 'no-output'} ok=${res.ok}${res.error ? ` err=${res.error}` : ''}`,
    // );
  } else if (process.platform === 'darwin') {
    await withOverlaysClickThrough(async () => {
      await macMouse(() => {
        return `const ev = $.CGEventCreateScrollWheelEvent($.CGEventCreate(null), $.kCGScrollEventUnitLine, 1, ${-notches});
  $.CGEventPost($.kCGHIDEventTap, ev);`;
      }, 0, 0);
    });
  } else {
    await withOverlaysClickThrough(async () => {
      const button = notches > 0 ? '4' : '5';
      for (let i = 0; i < Math.abs(notches); i++) {
        await runCommand('xdotool', ['click', button]);
      }
    });
  }
  await sleepBetweenActions();
}

// Capture-mode forwarding (Windows)
//
// Forward outside clicks/scrolls to the app under the cursor by synthesizing
// REAL input (clickAt / scrollLines). The overlay's own click-through override
// (withOverlaysClickThrough) briefly drops it to click-through so the
// synthesized events reach the app underneath.
//
// We deliberately do NOT post WM_LBUTTONDOWN/WM_MOUSEWHEEL into the target's
// message queue here anymore: Chromium apps (Gemini, etc.) frequently drop
// posted messages that arrive without the corresponding pointer-input state,
// which read as "need to click 2-3 times for one click". Real input synthesis
// is what the user's own physical clicks are, so it is exactly as reliable.
//
// The click-through window is kept near-imperceptible by running the
// synthesis in the persistent PowerShell worker (see windowsMouse) — the
// overlay's custom cursor only has to concede to the OS cursor for the ~30ms
// the actual mouse_event takes, not the ~1s a cold PowerShell spawn costs.

// Forward an outside click to the app under the cursor (used by capture mode:
// the overlay swallowed the user's physical click, so Spirit replays it for
// them). `x`/`y` are screen coordinates.
export async function forwardClickAt(
  x: number,
  y: number,
  opts: { double?: boolean; button?: 'left' | 'right' } = {},
): Promise<void> {
  await clickAt(x, y, opts);
}

// Forward a scroll gesture to the app under the cursor (capture mode).
export async function forwardScroll(delta: number): Promise<void> {
  await scrollLines(delta);
}

// Bring a freshly-launched app's main window to the foreground so subsequent
// type_text / press_key land in that app and not in whatever had focus before
// (usually Spirit's own overlay). On Windows this waits up to 4s for the
// window to appear, then SetForegroundWindow via the AttachThreadInput trick
// (a plain SetForegroundWindow is ignored when the caller lacks foreground
// rights). macOS `open -a` already activates the app, so that path is a no-op.
export async function focusProcessWindows(names: string[]): Promise<boolean> {
  releaseOverlayFocus();
  if (names.length === 0) return true;
  try {
    if (process.platform === 'win32') {
      const candidates = JSON.stringify(names);
      // Runs in the persistent PowerShell worker (see ps-worker.ts): the
      // SpiritFG.Native assembly is preloaded there, so this avoids a ~1s
      // cold powershell.exe spawn on every launch_app. The poll window is
      // capped at 1500ms so the request can never hold the shared worker
      // queue for long, and the worker forbids `exit` (it would kill the
      // shared process), so success/failure is signalled via pipeline text.
      const script = `
$candidates = ${candidates}
$deadline = (Get-Date).AddMilliseconds(1500)
$target = $null
while ((Get-Date) -lt $deadline -and -not $target) {
  $target = Get-Process -Name $candidates -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $target) { Start-Sleep -Milliseconds 150 }
}
if (-not $target) { 'NO_TARGET' } else {
  [SpiritFG.Native]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
  $fg = [SpiritFG.Native]::GetForegroundWindow()
  $dummy = 0
  $fgThread = [SpiritFG.Native]::GetWindowThreadProcessId($fg, [ref]$dummy)
  $myThread = [SpiritFG.Native]::GetCurrentThreadId()
  if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null }
  [SpiritFG.Native]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
  if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }
  'OK'
}
`;
      const out = await runPowerShell(script, 4000);
      return out.trim().toUpperCase().includes('NO_TARGET') ? false : true;
    }
    if (process.platform === 'linux') {
      const res = await runCommand('xdotool', [
        'search',
        '--sync',
        '--onlyvisible',
        '--class',
        names[0],
        'windowactivate',
      ]);
      return res.ok;
    }
  } catch {
    /* best-effort focus; input synthesis continues regardless */
  }
  return true;
}

// Read the title of the CURRENT foreground window. Used to verify a focus
// action landed and to tell the agent (and type_text) which window it would
// type/click into. Returns null when no title could be read.
export async function readForegroundTitle(): Promise<string | null> {
  if (process.platform === 'win32') {
    try {
      const out = await runPowerShell(
        `
$h = [SpiritFG.Native]::GetForegroundWindow()
$len = [SpiritFG.Native]::GetWindowTextLength($h)
if ($len -gt 0) {
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][SpiritFG.Native]::GetWindowText($h, $sb, $sb.Capacity)
  $sb.ToString()
} else { '' }
`,
        3000,
      );
      return out.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

// Focus a window by TITLE substring (e.g. "Notepad", "MyFile.txt — Notepad").
// Matches any visible process main-window whose title contains the text, then
// brings it to the foreground via the same AttachThreadInput trick
// focusProcessWindows uses. Returns true when a matching window was focused.
export async function focusWindowByTitle(title: string): Promise<boolean> {
  const want = title.trim().toLowerCase();
  if (!want) return false;
  if (process.platform === 'win32') {
    try {
      const escaped = title.replace(/'/g, "''").replace(/\\/g, '\\\\');
      const script = `
$want = '*${escaped}*'
$target = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like $want) } | Select-Object -First 1
if (-not $target) { 'NO_TARGET' } else {
  [SpiritFG.Native]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
  $fg = [SpiritFG.Native]::GetForegroundWindow()
  $dummy = 0
  $fgThread = [SpiritFG.Native]::GetWindowThreadProcessId($fg, [ref]$dummy)
  $myThread = [SpiritFG.Native]::GetCurrentThreadId()
  if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null }
  [SpiritFG.Native]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
  if ($fgThread -ne $myThread) { [SpiritFG.Native]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }
  'OK'
}
`;
      const out = await runPowerShell(script, 4000);
      return out.trim().toUpperCase().includes('NO_TARGET') ? false : true;
    } catch {
      return false;
    }
  }
  return false;
}
