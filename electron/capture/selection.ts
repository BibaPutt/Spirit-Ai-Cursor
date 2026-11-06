// Selected-text capture — the efficient replacement for Python spirit's
// "always Ctrl+C on launch".
//
// Strategy (accessibility reads only — we NEVER synthesize keystrokes and
// never touch the user's clipboard):
//  1. Windows UIA (UI Automation) reads the selection from the control that
//     owns it. The target window is resolved DETERMINISTICALLY so the read
//     can never race Spirit's overlay stealing focus: at trigger time the
//     window UNDER THE TRIGGER CURSOR is pinned (WindowFromPoint →
//     GetAncestor — still valid after the overlay takes focus), and the
//     submit retry reuses the agent-target hwnd. A cheap FocusedElement
//     ancestor walk runs first (terminal / editors expose their selection
//     there, so the common case is ~35ms), then three window-anchored tree
//     searches: FromHandle on the window EXACTLY under the trigger point,
//     FromPoint at the trigger point, and FromHandle on the resolved
//     top-level window. The under-point / hover entries exist because
//     Chromium browsers (Chrome, Arc, Edge) expose their page text + selection
//     under the renderer child window (Chrome_RenderWidgetHostHWND) and via
//     hover, NOT under the top-level frame — the frame tree stops at the
//     browser chrome. Both TextPattern and SelectionPattern are probed
//     (Chromium exposes selection through the former, list/grid controls
//     through the latter) and every selected range is joined. Tabs are NOT
//     probed as selections: a selected browser tab would otherwise come back
//     as gibberish instead of the page text.
//  2. macOS reads AXSelectedText from the focused accessibility element
//     (and its ancestors) via System Events — also zero keystrokes.
//  3. No clipboard fallback. The user's selection is read natively or not
//     at all; Spirit never presses Ctrl+C and never overwrites the
//     pasteboard (the user's explicit, hard constraint).
//
// Timing: Chromium builds its accessibility tree lazily and the first UIA
// read can stall for seconds, so the TRIGGER read runs with generous caps
// (5000ms internal / 8000ms exec) — it is fire-and-forget and never gates
// the box open, so a slow tree only delays the chip. The SUBMIT retry runs
// on the latency-sensitive submit path and uses tight caps so a no-selection
// read stays fast. Every read logs a `[selection]` diagnostic (path,
// duration, byte length, truncated preview) for debugging.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSelectionPowerShell } from './ps-worker';

const execFileP = promisify(execFile);

// Upper bounds inside the PowerShell process. Chromium-based controls can
// block the UIA read for a long time; if a walk exceeds its cap we bail and
// return nothing rather than stalling the caller.
const UIA_TRIGGER_INTERNAL_MAX_MS = 5000;
const UIA_TRIGGER_EXEC_TIMEOUT_MS = 8000;
const UIA_RETRY_INTERNAL_MAX_MS = 1500;
const UIA_RETRY_EXEC_TIMEOUT_MS = 4000;

// Runs inside the persistent PowerShell worker, so it must output through
// the PIPELINE (return), never [Console]::Out.Write, and must not `exit`.
// `cursor` pins the target window at trigger time (the window under the
// wiggle point, resolved BEFORE the overlay takes focus); `hwnd` is used
// directly on the submit retry. With neither, the read falls back to
// GetForegroundWindow.
function buildUiaScript(
  cursor: { x: number; y: number } | null | undefined,
  hwnd: string | number | null | undefined,
  internalMaxMs: number,
): string {
  const pointBlock = cursor
    ? `
$pt = New-Object 'SpiritFG.Native+POINT'
$pt.X = [int]${Math.round(cursor.x)}
$pt.Y = [int]${Math.round(cursor.y)}`
    : `
$pt = $null`;
  const hwndLit = Number(hwnd) || 0;
  const electronPid = process.pid;
  return `
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$internalMax = ${internalMaxMs}
$electronPid = ${electronPid}
${pointBlock}
$targetHwnd = ${hwndLit}

function Get-SelectionText([System.Windows.Automation.AutomationElement]$el) {
  $tp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
    try {
      $ranges = $tp.GetSelection()
      if ($null -ne $ranges -and $ranges.Count -gt 0) {
        $parts = @()
        foreach ($r in $ranges) {
          $t = $r.GetText(-1)
          if ($null -ne $t -and $t.Length -gt 0) { $parts += $t }
        }
        if ($parts.Count -gt 0) { return ($parts -join [Environment]::NewLine) }
      }
    } catch { }
  }
  $sp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$sp)) {
    try {
      $sel = $sp.Current.GetSelection()
      if ($null -ne $sel -and $sel.Length -gt 0) {
        $parts = @()
        foreach ($s in $sel) {
          $nm = $s.Current.Name
          if ($null -ne $nm -and $nm.Length -gt 0) { $parts += $nm }
        }
        if ($parts.Count -gt 0) { return ($parts -join [Environment]::NewLine) }
      }
    } catch { }
  }
  return $null
}

# Resolve the window that owns the user's selection. Prefers the explicit
# hwnd, then the window under the trigger cursor, then the foreground window.
# Skips Spirit's own overlays (same pid) and Windows shell windows.
function Resolve-TargetHwnd([IntPtr]$hint, $pt) {
  $h = $hint
  if ($h -eq [IntPtr]::Zero -and $null -ne $pt) {
    try {
      $under = [SpiritFG.Native]::WindowFromPoint($pt)
      if ($under -ne [IntPtr]::Zero) { $h = [SpiritFG.Native]::GetAncestor($under, 2) }
    } catch { }
  }
  if ($h -eq [IntPtr]::Zero) {
    try { $h = [SpiritFG.Native]::GetForegroundWindow() } catch { }
  }
  if ($h -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  try {
    $clsSb = New-Object System.Text.StringBuilder -ArgumentList 256
    [void][SpiritFG.Native]::GetClassName($h, $clsSb, 256)
    $cls = $clsSb.ToString()
    if ($cls -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd','XamlExplorerHostIslandWindow','Progman','WorkerW','Shell_TrayTray')) { return [IntPtr]::Zero }
  } catch { }
  try {
    $procId = [uint32]0
    [void][SpiritFG.Native]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($procId -eq $electronPid) { return [IntPtr]::Zero }
  } catch { }
  return $h
}

# Cheap focused-element chain walk first: terminal / editors expose their
# selection on the focused control (or an ancestor), so the common case
# returns in tens of milliseconds.
try {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -ne $focused) {
    $el = $focused
    $guard = 0
    while ($null -ne $el -and $guard -lt 20) {
      if ($sw.ElapsedMilliseconds -gt $internalMax) { break }
      $guard++
      $text = Get-SelectionText $el
      if ($null -ne $text -and $text.Length -gt 0) { return $text }
      try { $el = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el) } catch { break }
    }
  }
} catch { }

# Window-anchored tree searches. When Spirit's overlay holds OS focus the
# focused chain reads our own (empty) input, while the user's selection sits
# in the app window under the trigger point. Three anchored entries are tried
# from cheapest to most reliable-entry; each is node/depth/time-bounded and
# only text/selection-capable control types are probed so the common
# no-selection case stays cheap.

function Find-SelectionInTree([System.Windows.Automation.AutomationElement]$root) {
  if ($null -eq $root) { return $null }
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@($root, 0))
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt 4000) {
    if ($sw.ElapsedMilliseconds -gt $internalMax) { break }
    $item = $queue.Dequeue()
    $el = $item[0]
    $depth = $item[1]
    $visited++
    if ($depth -gt 30) { continue }
    try {
      $ct = $el.Current.ControlType.ProgrammaticName
      $isText = $ct -in @('ControlType.Edit','ControlType.Document','ControlType.Text','ControlType.Hyperlink','ControlType.ComboBox')
      $isSel = $ct -in @('ControlType.List','ControlType.ListItem','ControlType.Tree','ControlType.TreeItem','ControlType.DataGrid','ControlType.DataItem','ControlType.ComboBox')
      if ($isText -or $isSel) {
        $text = Get-SelectionText $el
        if ($null -ne $text -and $text.Length -gt 0) { return $text }
      }
    } catch { }
    try {
      $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($c in $children) { $queue.Enqueue(@($c, ($depth + 1))) }
    } catch { }
  }
  return $null
}

function Test-SkipWindow([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $true }
  try {
    $procId = [uint32]0
    [void][SpiritFG.Native]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($procId -eq $electronPid) { return $true }
  } catch { }
  try {
    $clsSb = New-Object System.Text.StringBuilder -ArgumentList 256
    [void][SpiritFG.Native]::GetClassName($h, $clsSb, 256)
    $cls = $clsSb.ToString()
    if ($cls -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd','XamlExplorerHostIslandWindow','Progman','WorkerW','Shell_TrayTray')) { return $true }
  } catch { }
  return $false
}

# 1) The window EXACTLY under the trigger point. Chromium browsers expose their
# page text + selection under the RENDERER child window
# (Chrome_RenderWidgetHostHWND) — the top-level frame's UIA tree stops at the
# browser chrome, so the ancestor-top walk alone never found a page selection.
if ($null -ne $pt) {
  try {
    $under = [SpiritFG.Native]::WindowFromPoint($pt)
    if (-not (Test-SkipWindow $under)) {
      $rootUnder = [System.Windows.Automation.AutomationElement]::FromHandle($under)
      if ($null -ne $rootUnder) {
        $text = Find-SelectionInTree $rootUnder
        if ($null -ne $text -and $text.Length -gt 0) { return $text }
      }
    }
  } catch { }
  # 2) The hover element at the trigger point: Chromium can also present the
  # page as a Document control to FromPoint even when FromHandle above lands on
  # an opaque renderer Pane. The overlay's own DOM has no selection, so a
  # bounded walk over it simply returns null.
  try {
    $hover = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($pt.X, $pt.Y))
    if ($null -ne $hover) {
      $text = Find-SelectionInTree $hover
      if ($null -ne $text -and $text.Length -gt 0) { return $text }
    }
  } catch { }
}

# 3) The pinned top-level window (explicit hwnd on the submit retry, the
# window under the trigger point otherwise): terminal / editors / Notepad++
# keep their selection under controls inside this same frame.
try {
  $hwnd = Resolve-TargetHwnd ([IntPtr]::new([int64]$targetHwnd)) $pt
  if ($hwnd -ne [IntPtr]::Zero) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -ne $root) {
      $text = Find-SelectionInTree $root
      if ($null -ne $text -and $text.Length -gt 0) { return $text }
    }
  }
} catch { }
return $null
`;
}

async function windowsSelectionViaUIA(
  cursor?: { x: number; y: number } | null,
  hwnd?: string | number | null,
  retry = false,
): Promise<string | null> {
  const internalMaxMs = retry ? UIA_RETRY_INTERNAL_MAX_MS : UIA_TRIGGER_INTERNAL_MAX_MS;
  const execTimeoutMs = retry ? UIA_RETRY_EXEC_TIMEOUT_MS : UIA_TRIGGER_EXEC_TIMEOUT_MS;
  try {
    const script = buildUiaScript(cursor, hwnd, internalMaxMs);
    const text = await runSelectionPowerShell(script, execTimeoutMs);
    return text.trim() || null;
  } catch {
    return null;
  }
}

const MACOS_AX_SCRIPT = `
with timeout of 2 seconds
  tell application "System Events"
    set out to ""
    try
      set p to first application process whose frontmost is true
      set el to value of attribute "AXFocusedUIElement" of p
      set guard to 0
      repeat while (el is not missing value) and guard < 20
        set guard to guard + 1
        try
          set s to value of attribute "AXSelectedText" of el
          if s is not missing value and (s as string) is not "" then
            set out to s as string
            exit repeat
          end if
        end try
        try
          set el to value of attribute "AXParent" of el
        on error
          set el to missing value
        end try
      end repeat
    end try
    return out
  end tell
end timeout
`;

async function macosSelectionViaAX(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('osascript', ['-e', MACOS_AX_SCRIPT], {
      timeout: UIA_TRIGGER_EXEC_TIMEOUT_MS,
      windowsHide: true,
    });
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

// One-line `[selection]` diagnostic: which path produced the text, how long
// it took, how much text came back, and a truncated preview for spotting
// garbage captures.
function logSelection(path: string, ms: number, text: string): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  console.log(
    `[selection] path=${path} ms=${ms} bytes=${bytes}${preview ? ` text="${preview}"` : ''}`,
  );
}

// `retry` picks the tight caps for the latency-sensitive submit-time re-read;
// the default (trigger-time) read uses generous caps because it is
// fire-and-forget. `cursor` and `hwnd` are the window-resolve hints described
// above (either may be omitted; with neither, UIA falls back to the
// foreground window).
export interface SelectionReadOptions {
  cursor?: { x: number; y: number } | null;
  hwnd?: string | number | null;
  retry?: boolean;
}

export async function captureSelectedText(opts?: SelectionReadOptions): Promise<string> {
  const startedAt = Date.now();
  if (process.platform === 'win32') {
    const viaUia = await windowsSelectionViaUIA(opts?.cursor, opts?.hwnd, opts?.retry ?? false);
    if (viaUia) {
      logSelection('uia', Date.now() - startedAt, viaUia);
      return viaUia;
    }
  } else if (process.platform === 'darwin') {
    const viaAx = await macosSelectionViaAX();
    if (viaAx) {
      logSelection('ax', Date.now() - startedAt, viaAx);
      return viaAx;
    }
  }
  logSelection('none', Date.now() - startedAt, '');
  return '';
}
