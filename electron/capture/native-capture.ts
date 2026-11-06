// Windows-only screen capture that runs in the persistent capture PowerShell
// worker — GDI CopyFromScreen (System.Drawing) with SetProcessDPIAware.
//
// desktopCapturer.getSources is a documented source of app-wide freezes: it is
// a highly-expensive main-process API (electron#8246) and, with a full
// display-res thumbnail request (e.g. 3840x2160), it blocks the browser process
// that ALSO pumps the 33ms cursor heartbeat and composites the renderer's
// custom cursor. Every launch/switch/submit screenshot thus froze the whole app
// for ~0.5-2s — the "mouse stutters right after the overlay opens" symptom.
//
// This module instead copies EXACTLY the requested region in the worker process
// via BitBlt: ~10-50ms, zero impact on the main thread. Callers fall back to
// desktopCapturer on any failure (permission missing, process spawn failure,
// ...), so nothing regresses when the native path can't serve a read.

import { screen } from 'electron';
import { runCapturePowerShell } from './ps-worker';

export function isWindowsNativeCaptureSupported(): boolean {
  return process.platform === 'win32';
}

// Copy one physical-px rect of the virtual screen (origin = primary display's
// top-left, the space CopyFromScreen uses after SetProcessDPIAware) and return
// JPEG base64. Optionally downscaled so the long edge fits `maxDim`.
async function capturePhysicalRect(
  x: number,
  y: number,
  w: number,
  h: number,
  maxDim?: number,
): Promise<string | null> {
  if (!(w >= 1) || !(h >= 1)) return null;
  const scale = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const script = `
$x = ${Math.round(x)}
$y = ${Math.round(y)}
$w = ${Math.round(w)}
$h = ${Math.round(h)}
$outW = ${outW}
$outH = ${outH}
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$final = $null
try {
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  if ($outW -eq $w -and $outH -eq $h) {
    $final = $bmp
  } else {
    $final = New-Object System.Drawing.Bitmap($outW, $outH)
    $g2 = [System.Drawing.Graphics]::FromImage($final)
    try {
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, $outW, $outH)
    } finally {
      $g2.Dispose()
    }
  }
  $ms = New-Object System.IO.MemoryStream
  $final.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $b64 = [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
  if ($final -ne $bmp) { $final.Dispose() }
  Write-Output $b64
} finally {
  $g.Dispose()
  if (-not $bmp.IsDisposed) { $bmp.Dispose() }
}
`;
  try {
    const out = await runCapturePowerShell(script, 15000);
    const trimmed = (out ?? '').trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// Display-local logical-px rect (0,0 = display top-left, the frame work-area
// rects use) → physical virtual-screen px scaled by the display's scaleFactor.
export async function captureDisplayRectNative(
  rect: { x: number; y: number; width: number; height: number },
  displayId: number,
  maxDim?: number,
): Promise<string | null> {
  const all = screen.getAllDisplays();
  const disp = all.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
  const primary = screen.getPrimaryDisplay();
  const sf = disp.scaleFactor;
  const x = Math.round((disp.bounds.x + rect.x - primary.bounds.x) * sf);
  const y = Math.round((disp.bounds.y + rect.y - primary.bounds.y) * sf);
  const w = Math.round(rect.width * sf);
  const h = Math.round(rect.height * sf);
  return capturePhysicalRect(x, y, w, h, maxDim);
}

// Absolute logical-px rect (primary-monitor origin — the click/move_mouse
// coordinate space) → physical virtual-screen px.
export async function captureAbsoluteRectNative(
  rect: { x: number; y: number; width: number; height: number },
  maxDim?: number,
): Promise<string | null> {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const disp = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const primary = screen.getPrimaryDisplay();
  const sf = disp.scaleFactor;
  const x = Math.round((rect.x - primary.bounds.x) * sf);
  const y = Math.round((rect.y - primary.bounds.y) * sf);
  const w = Math.round(rect.width * sf);
  const h = Math.round(rect.height * sf);
  return capturePhysicalRect(x, y, w, h, maxDim);
}
