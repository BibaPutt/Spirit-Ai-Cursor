// Cursor-shape probe (Windows only).
//
// While the overlay is in capture mode its full-screen transparent window
// swallows the mouse and hides the OS arrow (`cursor: none` on the root), so
// the real cursor beneath it is never visible and `GetCursorInfo` just
// reports the overlay's empty cursor. To learn what the user is hovering we
// instead ask the window UNDER the pointer which cursor it would show:
//
//   1. GetCursorPos → point under the physical mouse
//   2. WindowFromPoint → topmost window at that point, walk it up to the
//      top-level window, then walk the z-order DOWN past Spirit's own
//      full-screen overlays (they would always win WindowFromPoint)
//   3. ChildWindowFromPointEx → deepest child at the point
//   4. SendMessageTimeout(WM_SETCURSOR, HTCLIENT|WM_MOUSEMOVE) → the app's
//      cursor-selection logic runs, calling SetCursor()
//   5. If the app RETURNED FALSE from WM_SETCURSOR (or hung), it never chose a
//      cursor — the default arrow is right. If it returned TRUE, the handle
//      it Set() is compared against LoadCursor(IDC_*) to map it to a Bibata
//      shape id.
//
// Runs on the dedicated cursor PowerShell worker (never the click/selection
// pools) at a throttled ~20Hz while capture mode is active. On failure or an
// unknown handle the previous shape is kept (default 'pointer').

import { runCursorPowerShell } from '../capture/ps-worker';
import { getSpiritWindowHandles } from '../capture/spirit-windows';
import { isCaptureModeActive } from './trigger';
import { getLastCursorMoveAt } from './activity';
import { broadcastCursorPosition, setCurrentCursorShape, setCurrentScrollbar } from '../ipc/handlers';

// Throttle: skip probe if <45ms since last probe. Cursor movement detection
// further skips the probe when the pointer is stationary (it can't change shape
// on its own). The cursor loop in cursor.ts drives the cadence; this throttle
// ensures we never probe faster than ~20Hz even at the cursor's 33ms tick.
const PROBE_THROTTLE_MS = 45;
const PROBE_TIMEOUT_MS = 4000;

const SHAPE_BY_IDC: Record<number, string> = {
  32512: 'pointer', // IDC_ARROW
  32513: 'text', // IDC_IBEAM
  32514: 'work', // IDC_WAIT
  32515: 'cross', // IDC_CROSS
  32642: 'dgn1', // IDC_SIZENWSE
  32643: 'dgn2', // IDC_SIZENESW
  32644: 'horz', // IDC_SIZEWE
  32645: 'vert', // IDC_SIZENS
  32646: 'move', // IDC_SIZEALL
  32648: 'unavailable', // IDC_NO
  32649: 'link', // IDC_HAND
  32650: 'busy', // IDC_APPSTARTING
  32651: 'help', // IDC_HELP
};

// Win32 non-client hit codes we care about: over a classic scrollbar the
// window's WM_NCHITTEST reports HTVSCROLL (vertical bar with its own arrow
// buttons) or HTHSCROLL (horizontal bar). Anything else (HTCLIENT=1, the
// title bar, resize frame, ...) means "not on a scrollbar".
const HTCAPTION = 2;
const HTCLIENT = 1;
const HTVSCROLL = 7;
const HTHSCROLL = 8;

function buildProbeScript(skipHwnds: string[]): string {
  const skipList = skipHwnds.length ? '@(' + skipHwnds.join(', ') + ')' : '@()';
  const mapBody = Object.entries(SHAPE_BY_IDC)
    .map(([idc, shape]) => `${idc} = '${shape}'`)
    .join('; ');
  return `
if (-not ("SpiritCursor.Native" -as [type])) {
  Add-Type -Namespace SpiritCursor -Name Native -MemberDefinition @'
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT pt, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern IntPtr GetCursor();
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);
'@
}
$GA_ROOT = 2
$GW_HWNDNEXT = 2
$CWP_SKIP = 3
$WM_NCHITTEST = 0x84
$HTVSCROLL = 7
$HTHSCROLL = 8
$skips = ${skipList}
$pt = New-Object 'SpiritCursor.Native+POINT'
[SpiritCursor.Native]::GetCursorPos([ref]$pt) | Out-Null
$hwnd = [SpiritCursor.Native]::WindowFromPoint($pt)
$root = [IntPtr]::Zero
if ($hwnd -ne [IntPtr]::Zero) {
  $hwnd = [SpiritCursor.Native]::GetAncestor($hwnd, $GA_ROOT)
  $root = $hwnd
}
function Get-HitTest {
  param([IntPtr]$h, $p)
  if ($h -eq [IntPtr]::Zero) { return -1 }
  $lp = [IntPtr]((($p.Y -shl 16) -band 0xFFFF0000) -bor ($p.X -band 0xFFFF))
  $res = [IntPtr]::Zero
  $ok = [SpiritCursor.Native]::SendMessageTimeout($h, $WM_NCHITTEST, [IntPtr]::Zero, $lp, 2, 30, [ref]$res)
  if ($ok -eq [IntPtr]::Zero) { return -1 }
  return $res.ToInt64()
}
$shape = 'pointer'
$scroll = 'N'
if ($root -ne [IntPtr]::Zero) {
  $hwnd = $root
  while ($hwnd -ne [IntPtr]::Zero -and $skips -contains $hwnd.ToInt64()) {
    $hwnd = [SpiritCursor.Native]::GetWindow($hwnd, $GW_HWNDNEXT)
  }
  if ($hwnd -ne [IntPtr]::Zero) {
    $child = [SpiritCursor.Native]::ChildWindowFromPointEx($hwnd, $pt, $CWP_SKIP)
    if ($child -ne [IntPtr]::Zero) { $hwnd = $child }
    # Scrollbar orientation: classic non-client scrollbars answer WM_NCHITTEST
    # with HTVSCROLL / HTHSCROLL. Ask the deepest child first; if it reports
    # something else (usually HTCLIENT), fall back to the top-level window —
    # some controls own their scrollbars while others belong to the frame.
    $hit = Get-HitTest $hwnd $pt
    if (($hit -ne $HTVSCROLL) -and ($hit -ne $HTHSCROLL)) {
      $hit = Get-HitTest $root $pt
    }
    if ($hit -eq $HTVSCROLL) {
      $scroll = 'V'
    } elseif ($hit -eq $HTHSCROLL) {
      $scroll = 'H'
    }
    $lParam = [IntPtr](1 -bor (0x200 -shl 16))
    $result = [IntPtr]::Zero
    $smt = [SpiritCursor.Native]::SendMessageTimeout($hwnd, 0x20, $hwnd, $lParam, 2, 30, [ref]$result)
    if ($smt -ne [IntPtr]::Zero -and $result -ne [IntPtr]::Zero) {
      # Window ignored WM_SETCURSOR (default processing) or hung — it never
      # called SetCursor, so the cursor for this point is the default arrow.
      $cur = [SpiritCursor.Native]::GetCursor()
      $map = @{ ${mapBody} }
      foreach ($k in $map.Keys) {
        $h = [SpiritCursor.Native]::LoadCursor([IntPtr]::Zero, [IntPtr]$k)
        if ($cur -eq $h) { $shape = $map[$k]; break }
      }
    }
  }
}
Write-Output ('SHAPE:' + $shape + ' SCROLL:' + $scroll)
`;
}

function parseProbe(out: string): { shape: string; scrollbar: 'vert' | 'horz' | null } | null {
  const m = /SHAPE:(\S+)\s+SCROLL:([VHN])/.exec(out);
  if (!m) return null;
  return {
    shape: m[1],
    scrollbar: m[2] === 'V' ? 'vert' : m[2] === 'H' ? 'horz' : null,
  };
}

let currentShape = 'pointer';
let currentScrollbar: 'vert' | 'horz' | null = null;
let inFlight = false;
let lastProbeAt = 0;

export async function probeOnce(): Promise<void> {
  if (inFlight || !isCaptureModeActive()) return;
  const now = Date.now();
  if (now - lastProbeAt < PROBE_THROTTLE_MS) return;
  // The window under a stationary cursor can't change its own shape, so skip
  // the PowerShell probe entirely until the pointer moves again. Resumes the
  // instant movement is detected by the cursor poll.
  if (lastProbeAt > 0 && getLastCursorMoveAt() <= lastProbeAt) return;
  lastProbeAt = now;
  inFlight = true;
  try {
    const out = await runCursorPowerShell(buildProbeScript(getSpiritWindowHandles()), PROBE_TIMEOUT_MS);
    const probe = parseProbe(out);
    if (probe && (probe.shape !== currentShape || probe.scrollbar !== currentScrollbar)) {
      currentShape = probe.shape;
      currentScrollbar = probe.scrollbar;
      setCurrentCursorShape(probe.shape);
      setCurrentScrollbar(probe.scrollbar);
      broadcastCursorPosition();
    }
  } catch {
    // Probe failed (worker cold start, hung app, ...) — keep the last shape.
  } finally {
    inFlight = false;
  }
}

// Shape probing is now driven by the unified cursor loop in cursor.ts.
// That loop calls probeOnce() on every tick; the function self-throttles
// (skips if <45ms since last probe, skips if cursor hasn't moved, skips
// if capture mode is off) so it naturally limits itself at the cursor's
// adaptive cadence. This eliminates the second independent setTimeout chain.
