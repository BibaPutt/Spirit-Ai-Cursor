// Foreground-app context — "which app is the user in right now, and which
// tab is open?" Ported from Python spirit's GetForegroundWindow tracking,
// but explicitly event-driven: captured on demand at trigger/submit time.
//
// Performance model (this file was rewritten for the box-open-lag fix):
//  - IDENTITY is cheap (~50ms): GetForegroundWindow + title + pid + process +
//    the CDP-port owner. It runs in the PERSISTENT PowerShell worker
//    (ps-worker.ts), so no process spawn and no UIA tree walk. The box-open
//    gate in main.ts awaits ONLY this.
//  - The URL/TAB walk is expensive (~1s): a bounded UIA BFS over the window
//    tree. It runs in the SAME worker but is never gated — `captureForegroundApp`
//    kicks it off in the background and the caller's `onEnriched` callback
//    feeds the chip when it lands, so the box opens instantly and the chip
//    pops in a moment later. The watcher additionally re-walks only when the
//    foreground window changed (or every ~8s), never once per second.
//
// Cross-platform:
//  - Windows: persistent PowerShell worker + user32 P/Invoke.
//  - macOS: osascript JXA over CGWindowListCopyWindowInfo (frontmost window,
//    or the window under the trigger cursor) + lsof for the CDP-port owner.
//  - Linux: xdotool (active window title + pid + window id → /proc/<pid>/comm
//    name).
// Any platform failure returns null so Spirit simply sends no app context.

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import type { AppContext } from '../types';
import { isSpiritWindowHandle } from './spirit-windows';
import { reconcileActiveTab } from './active-tab';
import { runPowerShell } from './ps-worker';

const execFileP = promisify(execFile);

// Chrome DevTools Protocol port. When a browser is launched with
// `--remote-debugging-port=9222`, GET /json lists its tabs with the exact
// active URL — the only way to read Arc's current tab with full path.
// Only honored when the foreground process is the port's owner (see
// windowsIdentity), so another app's CDP can never be mistaken for the
// browser the user is actually in.
const CDP_PORT = 9222;

async function cdpActivePage(): Promise<{ url: string; title: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    const targets = (await res.json()) as Array<{
      type?: string;
      url?: string;
      title?: string;
      active?: boolean;
    }>;
    const page =
      targets.find((t) => t.type === 'page' && t.active) ??
      targets.find((t) => t.type === 'page');
    if (!page || typeof page.url !== 'string') return null;
    if (!/^https?:\/\//i.test(page.url)) return null;
    return { url: page.url, title: typeof page.title === 'string' ? page.title : '' };
  } catch {
    return null;
  }
}

// Windows: the two script halves. Both run inside the shared PowerShell
// worker (user32 + UIAutomation assemblies are preloaded by the host), so
// they must output their result through the PIPELINE (ConvertTo-Json), never
// via [Console]::Out.Write, and must not `exit` (that kills the worker).

// Identity half — user32 only, no UIA. Runs on the box-open gate path.
// Get-NetTCPConnection is ~1s on this machine, so it only runs for browser
// processes and its result is cached in the worker host session ($script:…,
// which persists across requests) for 15s.
//
// When the trigger cursor is known (Windows), the window UNDER THE POINTER is
// the source of truth — the user points at the content they want help with,
// and GetForegroundWindow can be a transient shell flyout (Quick settings,
// taskbar…) that poisons both the app context AND the agent's click/read
// target. The point read resolves the top-level window via GetAncestor (the
// pointer can land on a child control) and falls back to the foreground
// window when the point hits nothing.
// Given a resolved top-level `$hwnd` (IntPtr), extract its identity — title,
// process name, pid, hwnd, and the CDP-port owner pid — and emit it as a
// single JSON object via the pipeline. Shared by the foreground read and the
// Z-order topmost walk so both produce the exact same shape. The caller is
// responsible for guaranteeing `$hwnd` is a valid top-level window before
// including this (the script's own guards only re-check the cheap invariants).
function windowsIdentityTail(): string {
  return `
if ($hwnd -eq [IntPtr]::Zero) { return $null }
# The Windows taskbar / desktop are explorer-owned SHELL windows, not apps. A
# transient focus loss (hotkey press, overlay show, alt-tab) can make
# GetForegroundWindow return them, which otherwise reports "File Explorer" as
# the current app (and the agent's target becomes the taskbar). Treat them as
# "no app" so callers keep the last real context instead.
$clsSb = New-Object System.Text.StringBuilder 256
[void][SpiritFG.Native]::GetClassName($hwnd, $clsSb, 256)
$cls = $clsSb.ToString()
if ($cls -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd','XamlExplorerHostIslandWindow','Progman','WorkerW','Shell_TrayTray')) { return $null }
$sb = New-Object System.Text.StringBuilder 1024
[void][SpiritFG.Native]::GetWindowText($hwnd, $sb, 1024)
$title = $sb.ToString()
$procId = [uint32]0
[void][SpiritFG.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$procName = ''
if ($procId -ne 0) {
  try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
}
# Fallback: GetWindowText can come back empty on some windows (notably
# Chromium-based). MainWindowTitle reads the same value but through a
# different path and often succeeds where GetWindowText stalls.
if ($title -eq '' -and $procId -ne 0) {
  try { $title = (Get-Process -Id $procId -ErrorAction Stop).MainWindowTitle } catch {}
}
# If the foreground process is a browser that owns the Chrome DevTools
# Protocol port, hand its PID to the caller so it can read the EXACT active
# tab via /json instead of the possibly-stale UIA URL. (Node only honors the
# match when it equals the foreground pid, so this can never hijack another
# app's CDP.) The probe is expensive (~1s) so non-browsers skip it entirely
# and browsers hit the 15s host-session cache.
$cdpPid = ''
if ($procName -match '^(arc|chrome|msedge|firefox|brave|vivaldi|opera|opera_gx|chromium|yandex|whale|sogouexplorer|360se|360chrome|maxthon|ucbrowser|puffin|epicprivacybrowser|iceweasel|seamonkey|palemoon|waterfox)$') {
  $now = [Environment]::TickCount64
  if ($null -eq $script:cdpCacheAt -or ($now - $script:cdpCacheAt) -gt 15000) {
    $script:cdpPid = ''
    try {
      $conn = Get-NetTCPConnection -LocalPort ${CDP_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($conn -and $conn.OwningProcess) { $script:cdpPid = [string]$conn.OwningProcess }
    } catch {}
    $script:cdpCacheAt = $now
  }
  $cdpPid = $script:cdpPid
}
@{ title = $title; process = $procName; pid = $procId; hwnd = $hwnd.ToInt64().ToString(); cdpPid = $cdpPid } | ConvertTo-Json -Compress
`;
}

function identityScript(cursor?: { x: number; y: number } | null): string {
  const pointRead =
    cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
      ? `$pt = New-Object 'SpiritFG.Native+POINT'
$pt.X = [int]${Math.round(cursor.x)}
$pt.Y = [int]${Math.round(cursor.y)}
$ptHwnd = [SpiritFG.Native]::WindowFromPoint($pt)
$hwnd = [SpiritFG.Native]::GetAncestor($ptHwnd, 2)`
      : `$hwnd = [SpiritFG.Native]::GetForegroundWindow()`;
  return `${pointRead}
${windowsIdentityTail()}`;
}

// Z-order topmost walk: while the box is open Spirit holds focus, so
// GetForegroundWindow reports the overlay (self). The overlay is a full-screen
// always-on-top window, so the user's real app sits BELOW it in the Z-order.
// Walk from the very top, skipping our own pid (every Spirit window shares
// the Electron main-process pid), the explorer shell/desktop windows, hidden
// windows, and title-less utility windows, and report the first real app
// window. This is how app/tab switches register while the box is open, on
// click (the clicked window is raised just below the overlay) and on keydown.
function windowsTopmostScript(): string {
  return `
$shellCls = @('Shell_TrayWnd','Shell_SecondaryTrayWnd','XamlExplorerHostIslandWindow','Progman','WorkerW','Shell_TrayTray','MultitaskingViewFrame','ForegroundStaging','Windows.UI.Core.CoreWindow')
$ownPid = [uint32]${process.pid}
$h = [SpiritFG.Native]::GetTopWindow([SpiritFG.Native]::GetDesktopWindow())
$guard = 0
while ($h -ne [IntPtr]::Zero -and $guard -lt 256) {
  $guard++
  $wpid = [uint32]0
  [void][SpiritFG.Native]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($wpid -ne $ownPid -and [SpiritFG.Native]::IsWindowVisible($h)) {
    $clsSb2 = New-Object System.Text.StringBuilder 256
    [void][SpiritFG.Native]::GetClassName($h, $clsSb2, 256)
    $cls2 = $clsSb2.ToString()
    if ($cls2 -notin $shellCls -and [SpiritFG.Native]::GetWindowTextLength($h) -gt 0) {
      $hwnd = $h
      ${windowsIdentityTail()}
      return
    }
  }
  $h = [SpiritFG.Native]::GetWindow($h, 2)
}
return $null
`;
}

async function windowsTopmost(): Promise<AppContext | null> {
  try {
    const raw = await runPowerShell(windowsTopmostScript(), 4000);
    return await parseIdentity(raw);
  } catch {
    return null;
  }
}

// URL/Tab half — bounded UIA BFS over the window's tree, by HWND. The
// expensive ~1s read; runs in the background, never on the gate path.
function windowsUrlScript(hwnd: string, windowTitle: string, stripLeft: number, stripTop: number): string {
  const title = windowTitle.replace(/'/g, "''");
  return `
$hwnd = [IntPtr]::new([int64]${hwnd})
$windowTitle = '${title}'
$stripLeft = [double]${stripLeft}
$stripTop = [double]${stripTop}

# Best-effort read of the active tab's URL AND live tab label via UI
# Automation, for ANY foreground window — no hardcoded browser list. Browser
# address bars come in two flavors over UIA:
#   - Chromium exposes the page URL on the Document control's Value AND the
#     address bar Edit's Value. The Edit often strips the scheme
#     ("sajon.notion.site/…" instead of "https://sajon.notion.site/…").
#   - Other browsers expose only the Edit/ComboBox, again with or without
#     the scheme (Arc, minimalist UIs, etc).
# So we prefer a scheme-qualified URL anywhere in the tree, and fall back to
# the first plausible bare-domain value from an Edit/ComboBox (the address
# bar) so scheme-less browsers still work. BFS is depth- and node-bounded so
# a huge page can't stall the worker.
#
# The URL is NOT always the current tab: Arc freezes its Document/address-bar
# value at the FIRST tab opened after launch and never refreshes it on tab
# switch. Its tab strip, however, exposes the ACTIVE tab's label live as a
# shallow Pane/Text near the top of the tree — we capture that as [tab] so
# the caller can reconcile a stale URL against the real current tab.
function Get-BrowserInfo([IntPtr]$hwnd, [string]$windowTitle, [double]$stripLeft, [double]$stripTop) {
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  } catch { return @{ url = ''; tab = '' } }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if (-not $root) { return @{ url = ''; tab = '' } }
    $valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue(@($root, 0))
    $depthLimit = 14
    $nodeLimit = 2500
    $visited = 0
    $bareFallback = ''
    $tab = ''
    # Tab-strip labels are shallow; page content hangs below the Document at
    # depth >= 5, so bounding the scan keeps page text out of the label.
    $tabDepthLimit = 4
    while ($queue.Count -gt 0 -and $visited -lt $nodeLimit) {
      $item = $queue.Dequeue()
      $el = $item[0]; $depth = $item[1]
      $visited++
      if ($depth -gt $depthLimit) { continue }
      $candidate = ''
      $isEdit = $false
      try {
        $ct = $el.Current.ControlType.ProgrammaticName
        if ($ct -eq 'ControlType.Edit' -or $ct -eq 'ControlType.ComboBox') {
          $isEdit = $true
          try { $candidate = $el.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } catch {}
          if (-not $candidate) {
            try { $candidate = $el.GetCurrentPattern($valuePattern).Current.Value } catch {}
          }
        }
        # Document Value is Chromium's full page URL; check it too.
        if ($ct -eq 'ControlType.Document') {
          try { $candidate = $el.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } catch {}
          if (-not $candidate) {
            try { $candidate = $el.GetCurrentPattern($valuePattern).Current.Value } catch {}
          }
        }
        if (-not $candidate) { try { $candidate = $el.Current.Name } catch {} }
        # Live active-tab label: a shallow, on-screen Pane/Text in the top
        # strip. Arc puts the current tab's label here and it updates on tab
        # switch even though the Document URL never does.
        if (-not $tab -and $depth -le $tabDepthLimit -and ($ct -eq 'ControlType.Pane' -or $ct -eq 'ControlType.Text')) {
          $c = [string]$candidate
          if ($c.Length -gt 0 -and $c.Length -le 120 -and $c -ne $windowTitle -and $c -notmatch '://' -and
              $c -notin @('AppWindow Custom Title Bar','Non Client Input Sink Window','Minimize','Maximize','Close','mainMenuButton','sidebarToggleButton','contentToolbarSplitViewMenu')) {
            $r = $el.Current.BoundingRectangle
            if ($r.Width -gt 0 -and $r.Width -le 400 -and $r.Height -ge 10 -and $r.Height -le 60 -and
                $r.Left -ge $stripLeft -and $r.Top -ge $stripTop -and $r.Top -le ($stripTop + 90)) {
              try {
                $off = $el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
                if ($off -ne $true) { $tab = $c }
              } catch {}
            }
          }
        }
      } catch {}
      if ($candidate -is [string]) {
        $c = $candidate.Trim()
        # Scheme-qualified URL (address bar, Document, anywhere) — strongest
        # signal, return immediately. The address bar comes before page
        # content in the tree, so this is almost always the right tab.
        if ($c.Length -le 2048 -and $c -match '^(https?|edge|chrome|brave|about)://' -and $c -notmatch '^https?://(www\.)?google\.(com|co\.\w+)/?$') {
          return @{ url = $c; tab = $tab }
        }
        # Bare host[:path] from an address-bar Edit/ComboBox (scheme-less
        # browsers). Keep the first one seen — BFS hits the toolbar before
        # the page, so this is the active tab, not page content.
        if ($isEdit -and -not $bareFallback -and $c.Length -ge 6 -and $c.Length -le 2048 -and
            $c -match '^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+\.[a-zA-Z]{2,}(\/[^\s]*|\?[^\s]*)?$') {
          $bareFallback = $c
        }
      }
      if ($depth -lt $depthLimit) {
        try {
          $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
          foreach ($c in $children) { $queue.Enqueue(@($c, ($depth + 1))) }
        } catch {}
      }
    }
    return @{ url = $bareFallback; tab = $tab }
  } catch {}
  return @{ url = ''; tab = '' }
}

try {
  $wr = New-Object 'SpiritFG.Native+RECT'
  if (-not [SpiritFG.Native]::GetWindowRect($hwnd, [ref]$wr)) { return @{ url = ''; tab = '' } | ConvertTo-Json -Compress }
  $stripLeft = [double]$wr.Left
  $stripTop = [double]$wr.Top
  $info = Get-BrowserInfo $hwnd $windowTitle $stripLeft $stripTop
  @{ url = $info.url; tab = $info.tab } | ConvertTo-Json -Compress
} catch {
  @{ url = ''; tab = '' } | ConvertTo-Json -Compress
}
`;
}

interface WindowsIdentity {
  title?: unknown;
  process?: unknown;
  pid?: unknown;
  hwnd?: unknown;
  cdpPid?: unknown;
}

async function parseIdentity(raw: string): Promise<AppContext | null> {
  const parsed = JSON.parse(raw) as WindowsIdentity;
  if (!parsed || typeof parsed.title !== 'string') return null;
  const ctx: AppContext = {
    title: parsed.title,
    process: typeof parsed.process === 'string' ? parsed.process : '',
    pid: Number(parsed.pid ?? 0) || 0,
    hwnd: typeof parsed.hwnd === 'string' ? parsed.hwnd : undefined,
  };
  // Exact active-tab URL via CDP, when the foreground browser itself owns
  // the debug port. The pid match is the gate: only the browser the user is
  // actually in can match, so we never read another app's tabs.
  const cdpOwner = Number(parsed.cdpPid ?? 0) || 0;
  if (ctx.pid > 0 && cdpOwner === ctx.pid) {
    try {
      const cdp = await cdpActivePage();
      if (cdp) {
        ctx.url = cdp.url;
        if (cdp.title) ctx.title = cdp.title;
      }
    } catch {
      /* CDP read failure never fails the identity read */
    }
  }
  return ctx;
}

// Fast identity read (no UIA). Runs via the persistent worker.
async function windowsIdentity(cursor?: { x: number; y: number } | null): Promise<AppContext | null> {
  try {
    const raw = await runPowerShell(identityScript(cursor), 4000);
    return await parseIdentity(raw);
  } catch {
    return null;
  }
}

// Warm the worker AND prime the CDP-owner cache at startup, so the first
// trigger doesn't pay the ~1.5s cold PowerShell start or the ~1s TCP probe.
// Best-effort; failures are ignored (the worker respawns lazily on first use).
export function primeWindowsContextCache(): void {
  if (process.platform !== 'win32') return;
  void runPowerShell(identityScript(), 10000).catch(() => {
    /* cold start failed — worker respawns on first real use */
  });
}

// UIA URL+tab read by window handle. Mutates `ctx` in place and reconciles
// the tab label. Skips the walk entirely when CDP already produced an exact
// URL (Arc + remote-debugging-port); reconcileActiveTab still runs so the
// window-title tab label stays correct.
async function enrichWindowsUrlAndTab(ctx: AppContext): Promise<void> {
  if (isSelfContext(ctx)) return;
  if (!ctx.hwnd) {
    reconcileActiveTab(ctx);
    return;
  }
  if (!ctx.url) {
    try {
      const raw = await runPowerShell(
        windowsUrlScript(ctx.hwnd, ctx.title, 0, 0),
        8000,
      );
      let parsed: { url?: unknown; tab?: unknown } | null = null;
      try {
        parsed = JSON.parse(raw) as { url?: unknown; tab?: unknown };
      } catch {
        console.warn(
          `[app-context] url-walk UNPARSEABLE hwnd=${ctx.hwnd} raw=${raw.slice(0, 200)}`,
        );
      }
      if (parsed && typeof parsed.url === 'string' && parsed.url) ctx.url = parsed.url;
      if (parsed && typeof parsed.tab === 'string' && parsed.tab) {
        ctx.activeTab = parsed.tab;
      }
      if (!ctx.url) {
        // console.warn(
          // `[app-context] url-walk empty hwnd=${ctx.hwnd} title='${ctx.title}' raw=${raw.slice(0, 120)}`,
          // );
      }
    } catch {
      // console.warn('[app-context] url-walk FAILED:', err);
    }
  }
  reconcileActiveTab(ctx);
}

async function windowsForeground(opts: CaptureOptions): Promise<AppContext | null> {
  let ctx = await windowsIdentity(opts.cursor);
  // While the box is open Spirit holds focus, so the foreground read often
  // comes back as the overlay itself (self). Fall back to the Z-order walk:
  // the overlay is a full-screen always-on-top window, so walking from the
  // very top past our own windows finds the app the user is actually looking
  // at beneath it. This is what lets the chip + submit follow app/tab
  // switches mid-session instead of freezing on "Spirit".
  if (!ctx || isSelfContext(ctx)) {
    ctx = await windowsTopmost();
  }
  if (!ctx) return null;
  if (opts.withUrl) {
    await enrichWindowsUrlAndTab(ctx);
    return ctx;
  }
  if (ctx.hwnd) {
    void enrichWindowsUrlAndTab(ctx).then(() => {
      // The URL/tab walk lands AFTER the box opened; make it available to the
      // agent's reading path (scene webfetch) by refreshing the stored target.
      noteExternalForegroundContext(ctx);
      opts.onEnriched?.(ctx);
    });
  }
  return ctx;
}

// macOS: CGWindowListCopyWindowInfo lists on-screen windows front-to-back with
// their owner pid, window id, bounds and name — no Accessibility permission
// needed (CGWindow captures are allowed once Screen Recording is granted).
// The frontmost non-Spirit window is the first layer-0 window that isn't our
// own pid; when the trigger cursor is known, the window UNDER the pointer is
// preferred (mirrors the Windows WindowFromPoint behaviour so the pointed-at
// app becomes both the context and the agent's action target).
const MACOS_CG_SCRIPT = (cursor: { x: number; y: number } | null) => `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const myPid = ${process.pid};
const cursor = ${cursor ? `{ x: ${cursor.x}, y: ${cursor.y} }` : 'null'};
const opts = 1 | 16; // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
const raw = $.CFBridgingRelease($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID));
const list = ObjC.unwrap(raw) || [];
let underCursor = null;
let frontmost = null;
for (let i = 0; i < list.length; i++) {
  const w = list[i];
  if (!w) continue;
  if (w.kCGWindowLayer !== 0) continue; // dock/menus sit on higher layers
  const pid = Number(w.kCGWindowOwnerPID);
  if (!(pid > 0) || pid === myPid) continue;
  if (w.kCGWindowAlpha === 0) continue;
  const b = w.kCGWindowBounds;
  if (!b || !(b.Width > 0) || !(b.Height > 0)) continue;
  const entry = {
    pid: pid,
    id: Number(w.kCGWindowNumber) || 0,
    name: String(w.kCGWindowName || ''),
    owner: String(w.kCGWindowOwnerName || ''),
    x: b.X, y: b.Y, width: b.Width, height: b.Height,
  };
  if (cursor && !underCursor && cursor.x >= b.X && cursor.x < b.X + b.Width && cursor.y >= b.Y && cursor.y < b.Y + b.Height) {
    underCursor = entry;
    break;
  }
  if (!frontmost) frontmost = entry;
}
JSON.stringify(underCursor || frontmost);
`;

// Owner pid of the CDP debug port (port 9222), cross-platform via lsof
// (macOS/Linux). Windows uses its own Get-NetTCPConnection probe. Returns 0
// when the port is closed or the owner can't be read — callers then skip CDP.
async function cdpOwnerPid(): Promise<number> {
  try {
    const { stdout } = await execFileP(
      'lsof',
      ['-nP', '-iTCP:9222', '-sTCP:LISTEN'],
      { timeout: 2000, windowsHide: true },
    );
    // Lines look like:  node  1234  user  3u  IPv4  56789  0t0  TCP *:9222 (LISTEN)
    // The header ("COMMAND PID USER ...") has no digits in the pid column.
    for (const line of stdout.split('\n')) {
      const m = /^\S+\s+(\d+)\s/.exec(line.trim());
      if (m) return Number(m[1]);
    }
  } catch {
    /* lsof missing, or the port isn't open */
  }
  return 0;
}

// Exact active-tab URL via CDP, gated on the browser ITSELF owning the debug
// port (never hijack another app's CDP). Only probed for browsers so callers
// stay fast. Windows reads the owner inline in identityScript (its
// Get-NetTCPConnection probe is ~1s and cached in the worker); this lsof path
// serves macOS and Linux.
async function applyCdpForBrowser(ctx: AppContext): Promise<void> {
  if (!ctx || ctx.pid <= 0) return;
  const isBrowser =
    BROWSER_PROCESSES.has(ctx.process.toLowerCase()) ||
    /^(safari|google chrome|microsoft edge|edge|firefox|arc|brave|opera|vivaldi|chromium|tor browser|waterfox|pale moon|seamonkey)$/.test(ctx.process);
  if (!isBrowser) return;
  const cdpOwner = await cdpOwnerPid();
  if (cdpOwner !== ctx.pid) return;
  try {
    const cdp = await cdpActivePage();
    if (cdp) {
      ctx.url = cdp.url;
      if (cdp.title) ctx.title = cdp.title;
    }
  } catch {
    /* CDP read failure never fails the identity read */
  }
}

async function macosForeground(
  cursor?: { x: number; y: number } | null,
): Promise<AppContext | null> {
  try {
    const { stdout } = await execFileP(
      'osascript',
      ['-l', 'JavaScript', '-e', MACOS_CG_SCRIPT(cursor ?? null)],
      { timeout: 4000, windowsHide: true },
    );
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return null;
    const parsed = JSON.parse(trimmed) as {
      pid?: number;
      id?: number;
      name?: string;
      owner?: string;
    };
    if (!parsed || typeof parsed.pid !== 'number' || parsed.pid <= 0) return null;
    const ctx: AppContext = {
      title: typeof parsed.name === 'string' ? parsed.name : '',
      process: (typeof parsed.owner === 'string' ? parsed.owner : '').toLowerCase(),
      pid: parsed.pid,
      // CGWindowID doubles as the agent target on macOS (like hwnd on Windows).
      hwnd: typeof parsed.id === 'number' && parsed.id > 0 ? String(parsed.id) : undefined,
    };
    // Exact active-tab URL via CDP when the browser owns the debug port.
    await applyCdpForBrowser(ctx);
    return ctx;
  } catch {
    return null;
  }
}

async function linuxForeground(): Promise<AppContext | null> {
  try {
    const [titleRes, pidRes, idRes] = await Promise.all([
      execFileP('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 3000 }),
      execFileP('xdotool', ['getactivewindow', 'getwindowpid'], { timeout: 3000 }).catch(() => ({
        stdout: '',
      })),
      execFileP('xdotool', ['getactivewindow'], { timeout: 3000 }).catch(() => ({
        stdout: '',
      })),
    ]);
    const title = titleRes.stdout.trim();
    if (!title) return null;
    const pid = Number(pidRes.stdout.trim() || 0) || 0;
    const hwnd = idRes.stdout.trim();
    let process = '';
    if (pid > 0) {
      try {
        process = (await fsp.readFile(`/proc/${pid}/comm`, 'utf-8')).trim();
      } catch {
        /* pid may have exited between the read and now */
      }
    }
    const ctx: AppContext = { title, process, pid };
    if (hwnd) ctx.hwnd = hwnd;
    return ctx;
  } catch {
    return null;
  }
}

interface CaptureOptions {
  // Await the expensive UIA URL walk before resolving (watcher tab re-checks).
  withUrl?: boolean;
  // Fired with the enriched context when a background URL walk lands.
  onEnriched?: (ctx: AppContext) => void;
  // Windows: prefer the window under the trigger cursor over the foreground
  // window (GetForegroundWindow can be a transient shell flyout). The pointed-
  // at window becomes both the app context and the agent's action target.
  cursor?: { x: number; y: number };
}

// One-shot foreground-app snapshot. Cross-platform, best-effort: any
// platform failure returns null so callers degrade to "no app context".
//
// On Windows this resolves FAST (identity only, ~50ms) and schedules the
// URL walk in the background — the box-open gate can await it without lag.
export async function captureForegroundApp(opts: CaptureOptions = {}): Promise<AppContext | null> {
  let ctx: AppContext | null = null;
  switch (process.platform) {
    case 'win32':
      ctx = await windowsForeground(opts);
      break;
    case 'darwin':
      ctx = await macosForeground(opts.cursor);
      break;
    case 'linux':
      ctx = await linuxForeground();
      break;
    default:
      return null;
  }
  // Remember the last REAL (non-Spirit) foreground window's handle. The
  // trigger-time read runs while the user's app is still foreground (before
  // the overlay takes focus), so this is populated before any agent turn — and
  // while the box is open every poll that finds the user's app refreshes it.
  if (ctx && ctx.hwnd && !isSelfContext(ctx)) {
    noteExternalForegroundContext(ctx);
  }
  return ctx ? stampFresh(ctx) : ctx;
}

// The app the user is LOOKING AT while the box is open — the topmost window
// beneath our full-screen always-on-top overlay, whatever currently holds
// focus. Used by the event-driven watcher (on click / tab-switch keys) and by
// the submit path, which must never trust a stale cached context. Windows uses
// the Z-order walk; macOS lists CGWindows front-to-back and skips our pid;
// Linux reads the active window (best-effort). Identity only — the caller
// enriches by handle when it needs the tab/URL.
export async function captureTopmostAppContext(): Promise<AppContext | null> {
  let ctx: AppContext | null = null;
  switch (process.platform) {
    case 'win32':
      ctx = await windowsTopmost();
      break;
    case 'darwin':
      ctx = await macosForeground(null);
      break;
    case 'linux':
      ctx = await linuxForeground();
      break;
    default:
      return null;
  }
  return ctx ? stampFresh(ctx) : ctx;
}

// Window under a screen point (global px). Windows: WindowFromPoint for the
// window the click landed on, falling back to the Z-order walk when the point
// hits the (click-through, topmost) overlay itself. macOS: the frontmost
// layer-0 window under the point. Linux: active window (best-effort).
export async function contextAtPoint(x: number, y: number): Promise<AppContext | null> {
  switch (process.platform) {
    case 'win32': {
      let ctx = await windowsIdentity({ x, y });
      if (!ctx || isSelfContext(ctx)) ctx = await windowsTopmost();
      return ctx ? stampFresh(ctx) : ctx;
    }
    case 'darwin': {
      const ctx = await macosForeground({ x, y });
      return ctx ? stampFresh(ctx) : ctx;
    }
    case 'linux': {
      const ctx = await linuxForeground();
      return ctx ? stampFresh(ctx) : ctx;
    }
    default:
      return null;
  }
}

// Stamp the capture-time provenance on a fresh snapshot. The LLM-facing
// renderer (appContextTextFrom) uses these to label the context "CONTEXT AS OF
// <time>", so the model can tell how fresh the observation is and treat older
// snapshots in the conversation as superseded.
function stampFresh(ctx: AppContext): AppContext {
  if (ctx.capturedAt && ctx.source === 'fresh') return ctx;
  return { ...ctx, capturedAt: Date.now(), source: 'fresh' };
}

// Enrich a captured context with its active tab/URL by window handle. Windows
// walks the UIA tree; macOS/Linux use the exact CDP URL when the browser owns
// the debug port. No-op for self/unknown contexts.
export async function enrichContextByHandle(ctx: AppContext): Promise<void> {
  if (!ctx || isSelfContext(ctx)) return;
  switch (process.platform) {
    case 'win32':
      await enrichWindowsUrlAndTab(ctx);
      break;
    case 'linux':
      await applyCdpForBrowser(ctx);
      break;
    case 'darwin':
      // macosForeground already applied the CDP read inline at capture time.
      break;
    default:
      break;
  }
}

// Unconditionally adopt a non-self window as the agent's current target. Used
// by the event-driven watcher when the user clicks a different window/tab:
// the click IS the switch, so unlike noteExternalForegroundContext (which
// refuses to clobber a target on a possibly-stale background walk) this always
// points the agent at the window the user just chose.
export function setExternalForeground(ctx: AppContext): void {
  if (!ctx || !ctx.hwnd || isSelfContext(ctx)) return;
  lastExternalForeground = {
    hwnd: ctx.hwnd,
    pid: ctx.pid || 0,
    process: ctx.process || '',
    url: ctx.url ?? '',
  };
}

// Store a foreground context as the agent's current action/reading target.
// Only when the window is the same one already targeted: a stale background
// URL walk must never clobber a target the user switched to meanwhile.
function noteExternalForegroundContext(ctx: AppContext): void {
  if (!ctx.hwnd || isSelfContext(ctx)) return;
  if (lastExternalForeground.hwnd && ctx.hwnd !== lastExternalForeground.hwnd) return;
  lastExternalForeground = {
    hwnd: ctx.hwnd,
    pid: ctx.pid || 0,
    process: ctx.process || '',
    url: ctx.url ?? '',
  };
}

// Self-capture guard. While the box is open Spirit holds focus, so a
// foreground-app read at submit time often returns Spirit itself — the
// caller must skip that context instead of letting it overwrite the real
// app the user was in at trigger time.
export function isSelfContext(ctx: AppContext | null): boolean {
  if (!ctx) return false;
  // Every Spirit BrowserWindow shares the Electron main-process pid on all
  // platforms, so a foreground window owned by our own pid is Spirit itself.
  if (ctx.pid > 0 && ctx.pid === process.pid) return true;
  // The CUA driver is a separate process but OURS (vendored daemon + its
  // AgentCursorOverlay window). Reading it as "the current app" poisoned
  // chips context and agent grounding with our own overlay — skip it too.
  const proc = (ctx.process ?? '').toLowerCase().replace(/\.exe$/, '');
  if (proc === 'cua-driver' || proc === 'cua_driver') return true;
  // Belt-and-suspenders: the foreground hwnd may belong to a Spirit window
  // (e.g. About) even if the pid read was unreliable. Windows-only.
  return isSpiritWindowHandle(ctx.hwnd);
}

// The window the agent should act on while the box is open: the last REAL
// (non-Spirit) foreground window. During an agent loop the overlay holds focus,
// so GetForegroundWindow alone would read Spirit's own window — this is what
// ui_read/see_screen/ui_click target instead. Populated on every non-self
// foreground read (the trigger-time read is the first one, and it happens
// while the user's app is still in the foreground).
let lastExternalForeground: {
  hwnd: string | null;
  pid: number;
  process: string;
  url: string;
} = { hwnd: null, pid: 0, process: '', url: '' };

// The window the agent should act on, decoded into the per-platform window id
// plus its owning process id. `id` is a user32 HWND on Windows, a CGWindowID
// on macOS, or an X11 window id on Linux — each in the coordinate space that
// platform's click/read tools already use. `pid` is only populated on
// macOS/Linux (Windows tools address windows by HWND directly).
export function resolveAgentTarget(): { id: number | null; pid: number | null } {
  const s = lastExternalForeground.hwnd;
  if (!s) return { id: null, pid: null };
  const n = Number(s);
  return {
    id: Number.isFinite(n) && n > 0 ? n : null,
    pid: lastExternalForeground.pid || null,
  };
}

// HWND (as a number, or null) of the window the agent should act on. Null when
// no real app has been observed yet — callers should report a clear "can't
// read the window" instead of walking Spirit itself.
export function resolveAgentTargetHwnd(): number | null {
  return resolveAgentTarget().id;
}

// Process name + page URL of the window the agent acts on. Used by the scene
// to decide whether it can webfetch the page text instead of OCR-ing it: a
// URL is only present for browser windows (only browsers get URL enrichment),
// so a non-empty http(s) url means "we are in a browser".
export function agentTargetAppContext(): { process: string; url: string } {
  return {
    process: lastExternalForeground.process || '',
    url: lastExternalForeground.url || '',
  };
}

// Is this process/url combination a browser page we can fetch? Process-name
// check for known browsers, plus any http(s) URL (covers every browser,
// including ones not in the known-name list).
export function isBrowserContext(processName: string, url: string): boolean {
  if (BROWSER_PROCESSES.has(processName.toLowerCase())) return true;
  return /^https?:\/\//i.test(url);
}

// Re-read the foreground window after a screen-changing action (launch_app /
// open_url). Those actions open a NEW window, and without a refresh the agent
// keeps acting on the window observed at trigger time even though the launch
// moved focus elsewhere. Best-effort: if the foreground is Spirit itself (or
// the read fails), the previous target is kept.
export async function refreshAgentTargetHwnd(): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const out = await runPowerShell(
        `
$fg = [SpiritFG.Native]::GetForegroundWindow()
if ($fg -ne [IntPtr]::Zero) { $fg.ToInt64() } else { '0' }
`,
        4000,
      );
      const n = Number(out.trim());
      if (!Number.isFinite(n) || n <= 0) return;
      const hwnd = String(n);
      if (!isSpiritWindowHandle(hwnd)) {
        lastExternalForeground = { ...lastExternalForeground, hwnd };
      }
    } else if (process.platform === 'darwin') {
      const ctx = await macosForeground(null);
      if (ctx && ctx.hwnd && !isSelfContext(ctx)) {
        lastExternalForeground = {
          hwnd: ctx.hwnd,
          pid: ctx.pid || 0,
          process: ctx.process || '',
          url: ctx.url ?? '',
        };
      }
    } else if (process.platform === 'linux') {
      const ctx = await linuxForeground();
      if (ctx && ctx.hwnd && !isSelfContext(ctx)) {
        lastExternalForeground = {
          hwnd: ctx.hwnd,
          pid: ctx.pid || 0,
          process: ctx.process || '',
          url: ctx.url ?? '',
        };
      }
    }
  } catch {
    /* best-effort refresh; keep the previous target */
  }
}

// Known browser window-title suffixes. Browsers put the active tab at the
// FRONT of the title and their own name at the end ("weather - Google
// Search - Microsoft Edge"); stripping the suffix recovers the tab title.
// Matched case-insensitively so e.g. "… - MICROSOFT EDGE" still strips.
const BROWSER_TITLE_NAMES = [
  'Microsoft Edge',
  'Google Chrome',
  'Mozilla Firefox',
  'Brave',
  'Arc',
  'Vivaldi',
  'Opera GX',
  'Opera',
  'Chromium',
  'Yandex',
  'Naver Whale',
  'Whale',
  'QQ Browser',
  'Sogou Explorer',
  '360 Secure Browser',
  'Maxthon',
  'Puffin',
  'Tor Browser',
  'Waterfox',
  'Pale Moon',
  'SeaMonkey',
  'UC Browser',
  'Epic Privacy Browser',
];

export function tabTitleFromWindow(title: string): string {
  if (!title) return '';
  const lower = title.toLowerCase();
  for (const name of BROWSER_TITLE_NAMES) {
    const suffix = ` - ${name}`;
    if (lower.endsWith(suffix.toLowerCase())) {
      const tab = title.slice(0, -suffix.length).trim();
      if (tab) return tab;
    }
  }
  return title;
}

const BROWSER_PROCESSES = new Set([
  'msedge',
  'chrome',
  'firefox',
  'brave',
  'arc',
  'vivaldi',
  'opera',
  'opera_gx',
  'chromium',
  'yandex',
  'whale',
  'qq',
  'sogouexplorer',
  '360se',
  '360chrome',
  'maxthon',
  'ucbrowser',
  'epicprivacybrowser',
  'puffin',
  'tor browser',
  'waterfox',
  'palemoon',
  'iceweasel',
  'seamonkey',
]);

// Process-name → friendly display name for common apps. Anything unknown
// falls back to a title-cased version of the process name.
const APP_NAMES: Record<string, string> = {
  msedge: 'Microsoft Edge',
  chrome: 'Google Chrome',
  firefox: 'Mozilla Firefox',
  brave: 'Brave',
  arc: 'Arc',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  chromium: 'Chromium',
  yandex: 'Yandex Browser',
  notepad: 'Notepad',
  winword: 'Microsoft Word',
  excel: 'Microsoft Excel',
  powerpnt: 'Microsoft PowerPoint',
  outlook: 'Microsoft Outlook',
  explorer: 'File Explorer',
  calculator: 'Calculator',
  code: 'Visual Studio Code',
  terminal: 'Terminal',
  konsole: 'Konsole',
  gnome_terminal: 'Terminal',
  spotify: 'Spotify',
};

function humanAppName(process: string): string {
  const key = process.toLowerCase();
  if (APP_NAMES[key] || APP_NAMES[`${key}.exe`]) {
    return APP_NAMES[key] || APP_NAMES[`${key}.exe`];
  }
  const stem = process.replace(/\.exe$/i, '').replace(/[-_]/g, ' ').trim();
  if (!stem) return process || 'Unknown app';
  return stem
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export type ConversationKind = 'email' | 'chat';

// Deterministic conversation classification: is the current screen a chat
// thread or an email? Matches on process name (desktop apps), URL (web apps),
// and window/tab title. Email wins over chat when both match. Implemented in
// ./conversation-kind (pure) so tests can import it without Electron.
import { conversationKindFromContext } from './conversation-kind';
export { conversationKindFromContext } from './conversation-kind';

// LLM-injected context line, e.g.:
//   CONTEXT AS OF 14:32:05
//   Current app: Microsoft Edge (msedge)
//   Active tab: weather - Google Search
//   Active URL: https://weather.example/?q=seattle
// The "CONTEXT AS OF" header carries the snapshot's capture time (and an
// "(approximate)" marker when the snapshot is a re-used fallback), so the
// model can judge how fresh the observation is and treat any earlier,
// differing app/tab shown elsewhere in the conversation as superseded.
export function appContextTextFrom(ctx: AppContext): string {
  const appName = humanAppName(ctx.process);
  const appLine = ctx.process
    ? `Current app: ${appName} (${ctx.process})`
    : `Current app: ${appName}`;
  // Any process with a detected URL is treated as a browser (works for
  // every browser, not just the known-name list).
  const isBrowser = BROWSER_PROCESSES.has(ctx.process.toLowerCase()) || Boolean(ctx.url);
  const subject = isBrowser ? tabTitleFromWindow(ctx.title) : ctx.title;
  const lines = [appLine];
  if (subject) lines.push(`${isBrowser ? 'Active tab' : 'Window'}: ${subject}`);
  if (ctx.url) lines.push(`Active URL: ${ctx.url}`);
  const kind = conversationKindFromContext(ctx);
  if (kind) lines.push(`Conversation type: ${kind}`);
  const header = contextAsOfLine(ctx);
  return header ? `${header}\n${lines.join('\n')}` : lines.join('\n');
}

// "CONTEXT AS OF <time>" freshness line. When no capture time is known (legacy
// contexts / test fixtures) the line is omitted entirely, keeping the rendered
// block identical to its pre-provenance shape.
function contextAsOfLine(ctx: AppContext): string {
  const when = typeof ctx.capturedAt === 'number' && ctx.capturedAt > 0
    ? new Date(ctx.capturedAt).toLocaleTimeString()
    : '';
  if (!when) return '';
  const approximate = ctx.stale ? ' (approximate — cached from an earlier read)' : '';
  return `CONTEXT AS OF ${when}${approximate}`;
}

// Short renderer-chip label, e.g. "Microsoft Edge · weather - Google Search
// · example.com/…". URLs are stripped of scheme and clamped so the bubble
// stays readable.
export function previewFromAppContext(ctx: AppContext): string {
  const appName = humanAppName(ctx.process);
  const tab = tabTitleFromWindow(ctx.title);
  const parts = [appName];
  if (tab && tab !== appName) parts.push(tab);
  if (ctx.url) {
    const chipUrl = clampUrlForChip(ctx.url);
    // Host-level fallback URLs (e.g. "https://instagram.com/" reconciled
    // from the live tab label) read identically to the tab label; showing
    // both is noise, so skip the URL when it duplicates the tab.
    if (chipUrl.toLowerCase() !== tab.toLowerCase()) parts.push(chipUrl);
  }
  return parts.join(' · ');
}

// Readable URL for the chip: drop the scheme, keep host, clamp length.
function clampUrlForChip(url: string): string {
  let u = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  u = u.replace(/^www\./, '');
  if (u.length <= 46) return u;
  return u.slice(0, 43) + '…';
}
