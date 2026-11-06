import { desktopCapturer, nativeImage, screen } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSettingsLight } from '../store/settings';
import { runPowerShell } from './ps-worker';
import { resolveAgentTarget } from './app-context';
import {
  captureAbsoluteRectNative,
  captureDisplayRectNative,
  isWindowsNativeCaptureSupported,
} from './native-capture';

const execFileP = promisify(execFile);

// Last full-res (native resolution) screenshot captured by captureScreenForSubmit.
// Stored so the resolver's zoom-refine can crop from the original pixels instead
// of the pre-resized LLM image — critical for pixel-accurate visual elements.
let lastNativeB64: string | null = null;
export function getLastNativeScreenshot(): string | null { return lastNativeB64; }

// Default crop reduced from 1024x768 to 512x384 (~75% token savings
// on vision calls with negligible legibility loss for cursor-centered
// content). The user can either drag a rectangle for a larger area or
// override the constants via Settings (screenshotCropW / screenshotCropH).
const CROP_W_FALLBACK = 512;
const CROP_H_FALLBACK = 384;
const JPEG_QUALITY = 80;

// Token-aware pre-resize: shrink the screenshot to the EXACT dimensions the
// vision model will compute — not just a max-edge cap. Claude uses two limits:
//   1) longest edge ≤ 1568 px (standard tier)
//   2) visual tokens ⌈w/28⌉ × ⌈h/28⌉ ≤ 1568 (standard tier)
// A 1920×1080 image fits the edge limit but costs 2691 tokens — Claude resizes
// it to 1456×819. A simple 1568-edge cap would produce 1568×882, causing a 7%
// coordinate shift. This function computes the exact target so the image we send
// is exactly what the model sees — no server-side resize, no coordinate drift.
const LLM_MAX_EDGE = 1568;
const LLM_MAX_TOKENS = 1568;

/** Visual tokens consumed by an image: one token per 28×28 pixel patch. */
function countImageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/**
 * The exact size the vision model resizes an image to before processing.
 * Matches Anthropic's official resize algorithm (standard tier: 1568 edge,
 * 1568 tokens). Images that already fit are returned unchanged.
 */
function resizedSize(width: number, height: number, maxEdge = LLM_MAX_EDGE, maxTokens = LLM_MAX_TOKENS): [number, number] {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / 28) * 28 <= maxEdge &&
    Math.ceil(h / 28) * 28 <= maxEdge &&
    countImageTokens(w, h) <= maxTokens;

  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [rh, rw] = resizedSize(height, width, maxEdge, maxTokens);
    return [rw, rh];
  }

  const aspect = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const short = Math.max(Math.round(mid / aspect), 1);
    if (fits(mid, short)) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(Math.round(lo / aspect), 1)];
}

/**
 * Pre-resize a base64 JPEG to the exact dimensions the vision model will use.
 * Returns { resized, nativeB64 } where nativeB64 is the ORIGINAL full-res
 * image (for zoom-refine crops later).
 */
export function resizeImageForLLM(b64: string): { resized: string; nativeB64: string } {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (img.isEmpty()) return { resized: b64, nativeB64: b64 };
    const { width, height } = img.getSize();
    const [targetW, targetH] = resizedSize(width, height);
    if (targetW === width && targetH === height) return { resized: b64, nativeB64: b64 };
    const resized = img.resize({ width: targetW, height: targetH, quality: 'best' });
    const jpeg = resized.toJPEG(JPEG_QUALITY);
    return { resized: jpeg.length > 0 ? jpeg.toString('base64') : b64, nativeB64: b64 };
  } catch {
    return { resized: b64, nativeB64: b64 };
  }
}

/** Legacy wrapper: resize only, no native return. */
export function resizeImageMaxEdge(b64: string, maxEdge: number = LLM_MAX_EDGE): string {
  return resizeImageForLLM(b64).resized;
}

export function getCropDimensions(): { w: number; h: number } {
  try {
    const s = getSettingsLight();
    return {
      w: s.screenshotCropW || CROP_W_FALLBACK,
      h: s.screenshotCropH || CROP_H_FALLBACK,
    };
  } catch {
    // Settings store may not be ready in a corner case (very early startup).
    return { w: CROP_W_FALLBACK, h: CROP_H_FALLBACK };
  }
}

// All cropping + JPEG encoding goes through Electron's built-in `nativeImage`
// (Skia under the hood). Earlier versions used `sharp` for this, which pulled
// in libvips as a native binding — fine on macOS where we built locally, but
// a permanent thorn for cross-platform CI: the Windows/Linux artefacts of
// `sharp` weren't always copied into the asar-unpacked node_modules, and
// distributed builds would crash with "Cannot find module sharp" or a libvips
// load error. `nativeImage` is part of Electron itself, so it ships with the
// runtime by definition. No native modules to rebuild, no platform-specific
// binaries to package, no asarUnpack entries.

export async function captureAroundCursor(cursor: { x: number; y: number }): Promise<string> {
  // No overlay hiding needed: every overlay window has setContentProtection(true),
  // so Spirit's box/halo/cursor are excluded from the capture while remaining
  // visible on screen. Previously we hid the overlays for the whole capture,
  // which made the prompt box vanish for the capture's duration (~a few seconds
  // on cold Windows) and reappear — the "appears then comes back" flicker.
  // On Windows the capture itself runs in the persistent GDI worker (native
  // path) so the main thread that drives the cursor heartbeat is never blocked;
  // desktopCapturer is the automatic fallback (and the whole path on macOS /
  // Linux, where getSources does not freeze the app).
  if (isWindowsNativeCaptureSupported()) {
    const display = screen.getDisplayNearestPoint(cursor);
    const dims = getCropDimensions();
    const cropW = Math.min(dims.w, display.size.width);
    const cropH = Math.min(dims.h, display.size.height);
    const left = Math.max(0, Math.min(display.size.width - cropW, Math.round(cursor.x - display.bounds.x - cropW / 2)));
    const top = Math.max(0, Math.min(display.size.height - cropH, Math.round(cursor.y - display.bounds.y - cropH / 2)));
    const b64 = await captureDisplayRectNative({ x: left, y: top, width: cropW, height: cropH }, display.id);
    if (b64) return resizeImageMaxEdge(b64);
  }
  return resizeImageMaxEdge(await captureAroundCursorRaw(cursor));
}

async function captureAroundCursorRaw(cursor: { x: number; y: number }): Promise<string> {
  const display = screen.getDisplayNearestPoint(cursor);
  console.log('[screenshot] cursor', cursor, 'display', display.id, 'size', display.size);

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: display.size.width,
        height: display.size.height,
      },
    });
  } catch (e) {
    console.error('[screenshot] getSources threw', e);
    throw new Error(`getSources failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(
    '[screenshot] got',
    sources.length,
    'sources:',
    sources.map((s) => ({ id: s.id, display_id: s.display_id, empty: s.thumbnail.isEmpty() })),
  );

  if (sources.length === 0) {
    throw new Error(
      'No screen sources returned. Screen Recording permission missing. Quit Spirit, grant the permission in System Settings, then relaunch.',
    );
  }

  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0];

  const thumb = source.thumbnail;
  if (thumb.isEmpty()) {
    throw new Error(
      'Screen capture returned empty. Screen Recording permission missing or not yet inherited. Quit Spirit and relaunch after granting.',
    );
  }

  const size = thumb.getSize();
  console.log('[screenshot] thumb size', size);

  const localX = cursor.x - display.bounds.x;
  const localY = cursor.y - display.bounds.y;

  const dims = getCropDimensions();
  const cropW = Math.min(dims.w, size.width);
  const cropH = Math.min(dims.h, size.height);
  const left = Math.max(0, Math.min(size.width - cropW, Math.round(localX - cropW / 2)));
  const top = Math.max(0, Math.min(size.height - cropH, Math.round(localY - cropH / 2)));
  console.log('[screenshot] crop', { left, top, cropW, cropH });

  try {
    const cropped = thumb.crop({ x: left, y: top, width: cropW, height: cropH });
    const jpegBuf = cropped.toJPEG(JPEG_QUALITY);
    console.log('[screenshot] cropped jpeg bytes', jpegBuf.length);
    return jpegBuf.toString('base64');
  } catch (e) {
    console.error('[screenshot] crop failed', e);
    throw new Error(`Crop failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// User-defined selection rectangle (display-local coordinates, work-area
// frame, matching what the renderer's getBoundingClientRect returns). Lets
// the user drag a tight crop of exactly what they're asking about instead
// of relying on the 1024x768 cursor-centered default.
export async function captureRectFromDisplay(
  rect: { x: number; y: number; width: number; height: number },
  displayId: number,
): Promise<string> {
  // The drag-rectangle capture runs while the box is open. Overlays are
  // excluded from capture via setContentProtection(true), so no hiding needed —
  // the selection guides stay visible while the crop stays clean. Windows goes
  // through the GDI worker (native) so app-switch / paint-to-select captures
  // never freeze the cursor heartbeat; desktopCapturer is the fallback.
  if (isWindowsNativeCaptureSupported()) {
    const all = screen.getAllDisplays();
    const disp = all.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
    // `rect` is work-area local (the frame the renderer's drag rects and the
    // chips region use). Convert to display-local like captureRectFromDisplayRaw
    // does before handing the physical-rect math the display-bounds origin.
    const b64 = await captureDisplayRectNative(
      {
        x: rect.x + (disp.workArea.x - disp.bounds.x),
        y: rect.y + (disp.workArea.y - disp.bounds.y),
        width: rect.width,
        height: rect.height,
      },
      displayId,
    );
    if (b64) return resizeImageMaxEdge(b64);
  }
  return resizeImageMaxEdge(await captureRectFromDisplayRaw(rect, displayId));
}

async function captureRectFromDisplayRaw(
  rect: { x: number; y: number; width: number; height: number },
  displayId: number,
): Promise<string> {
  const allDisplays = screen.getAllDisplays();
  const display = allDisplays.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
  console.log('[screenshot] rect-capture', rect, 'display', display.id, 'size', display.size);

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: display.size.width,
        height: display.size.height,
      },
    });
  } catch (e) {
    console.error('[screenshot] getSources threw', e);
    throw new Error(`getSources failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (sources.length === 0) {
    throw new Error(
      'No screen sources returned. Screen Recording permission missing.',
    );
  }
  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  const thumb = source.thumbnail;
  if (thumb.isEmpty()) {
    throw new Error('Screen capture returned empty.');
  }

  const size = thumb.getSize();

  // The renderer reports rect in work-area coords (the overlay window covers
  // workArea, not full display bounds). Convert to full-display coords for
  // the crop by adding back the work-area offset relative to bounds.
  const workOffsetX = display.workArea.x - display.bounds.x;
  const workOffsetY = display.workArea.y - display.bounds.y;
  const left = Math.max(0, Math.min(size.width - 1, Math.round(rect.x + workOffsetX)));
  const top = Math.max(0, Math.min(size.height - 1, Math.round(rect.y + workOffsetY)));
  const width = Math.max(1, Math.min(size.width - left, Math.round(rect.width)));
  const height = Math.max(1, Math.min(size.height - top, Math.round(rect.height)));
  console.log('[screenshot] rect-crop', { left, top, width, height });

  try {
    const cropped = thumb.crop({ x: left, y: top, width, height });
    const jpegBuf = cropped.toJPEG(JPEG_QUALITY);
    console.log('[screenshot] rect-cropped jpeg bytes', jpegBuf.length);
    return jpegBuf.toString('base64');
  } catch (e) {
    console.error('[screenshot] rect-crop failed', e);
    throw new Error(`Crop failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function canCaptureScreen(): Promise<boolean> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length === 0) return false;
    return !sources[0].thumbnail.isEmpty();
  } catch (e) {
    console.error('[screenshot] canCaptureScreen error', e);
    return false;
  }
}

// Agentic `see_screen` capture — a fresh screenshot of the ACTIVE window so
// the model can see the result of its own navigation and click/scroll onward.

// see_screen captures at FULL native resolution — no downscale cap. The model
// annotates against REAL monitor pixels, so every [POINT]/[BOX]/[ARROW]
// coordinate it writes maps 1:1 to the screen (no "estimate small, multiply
// up" slop). Precision wins over the shot's image-token cost.

export interface WindowRect {
  absLeft: number;
  absTop: number;
  width: number;
  height: number;
  displayId: number;
}

// Bounds of the user's target window, in the same absolute screen-pixel
// coordinate space click/move_mouse use (Windows: primary-monitor-origin
// physical px via GetWindowRect; macOS: CGWindow points; Linux: X11 root px).
// Targets the window recorded at trigger time — never the overlay that holds
// focus during the agent loop.
export async function getActiveWindowRect(): Promise<WindowRect | null> {
  const target = resolveAgentTarget();
  if (process.platform === 'win32') return windowsWindowRect(target.id);
  if (process.platform === 'darwin') return macosWindowRect(target.id);
  if (process.platform === 'linux') return linuxWindowRect(target.id);
  return null;
}

async function windowsWindowRect(targetHwnd: number | null): Promise<WindowRect | null> {
  const hwndRead =
    targetHwnd === null
      ? `$hwnd = [SpiritFG.Native]::GetForegroundWindow()`
      : `$hwnd = [IntPtr]::new([int64]${targetHwnd})`;
  const script = `
${hwndRead}
if ($hwnd -eq [IntPtr]::Zero) { return $null }
$wr = New-Object 'SpiritFG.Native+RECT'
if (-not [SpiritFG.Native]::GetWindowRect($hwnd, [ref]$wr)) { return $null }
@{ left = $wr.Left; top = $wr.Top; right = $wr.Right; bottom = $wr.Bottom } | ConvertTo-Json -Compress
`;
  try {
    const raw = await runPowerShell(script, 4000);
    const parsed = JSON.parse(raw) as {
      left: number;
      top: number;
      right: number;
      bottom: number;
    };
    if (parsed.right <= parsed.left || parsed.bottom <= parsed.top) return null;
    const cx = (parsed.left + parsed.right) / 2;
    const cy = (parsed.top + parsed.bottom) / 2;
    const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
    // GetWindowRect is virtual-screen coords; convert to primary-monitor
    // origin (the same space click/move_mouse use via SetCursorPos).
    const primary = screen.getPrimaryDisplay();
    return {
      absLeft: Math.round(parsed.left - primary.bounds.x),
      absTop: Math.round(parsed.top - primary.bounds.y),
      width: Math.round(parsed.right - parsed.left),
      height: Math.round(parsed.bottom - parsed.top),
      displayId: display.id,
    };
  } catch {
    return null;
  }
}

// macOS: CGWindow bounds are already in the global point space that
// CGEventCreateMouseEvent (click/move_mouse) uses, and Electron DIPs equal
// points, so no conversion is needed.
const MACOS_BOUNDS_SCRIPT = (targetId: number | null) => `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const myPid = ${process.pid};
const wantId = ${targetId === null ? 'null' : String(targetId)};
const opts = 1 | 16; // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
const raw = $.CFBridgingRelease($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID));
const list = ObjC.unwrap(raw) || [];
let best = null;
for (let i = 0; i < list.length; i++) {
  const w = list[i];
  if (!w) continue;
  if (w.kCGWindowLayer !== 0) continue;
  const pid = Number(w.kCGWindowOwnerPID);
  if (!(pid > 0) || pid === myPid) continue;
  if (w.kCGWindowAlpha === 0) continue;
  const b = w.kCGWindowBounds;
  if (!b || !(b.Width > 0) || !(b.Height > 0)) continue;
  if (wantId !== null) {
    if (Number(w.kCGWindowNumber) === wantId) { best = { x: b.X, y: b.Y, width: b.Width, height: b.Height }; break; }
  } else {
    best = { x: b.X, y: b.Y, width: b.Width, height: b.Height };
    break;
  }
}
JSON.stringify(best);
`;

async function macosWindowRect(targetId: number | null): Promise<WindowRect | null> {
  try {
    const { stdout } = await execFileP(
      'osascript',
      ['-l', 'JavaScript', '-e', MACOS_BOUNDS_SCRIPT(targetId)],
      { timeout: 4000, windowsHide: true },
    );
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return null;
    const parsed = JSON.parse(trimmed) as {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      parsed.width <= 0 ||
      parsed.height <= 0
    ) {
      return null;
    }
    const x = parsed.x;
    const y = parsed.y;
    const width = parsed.width;
    const height = parsed.height;
    const display = screen.getDisplayNearestPoint({
      x: x + width / 2,
      y: y + height / 2,
    });
    return {
      absLeft: Math.round(x),
      absTop: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      displayId: display.id,
    };
  } catch {
    return null;
  }
}

// Linux: `xdotool getwindowgeometry --shell` reports the window's X11 root
// coordinates (physical px), the same space xdotool mousemove/click use.
async function linuxWindowRect(targetId: number | null): Promise<WindowRect | null> {
  const args =
    targetId === null
      ? ['getactivewindow', 'getwindowgeometry', '--shell']
      : ['getwindowgeometry', '--shell', String(targetId)];
  try {
    const { stdout } = await execFileP('xdotool', args, { timeout: 3000, windowsHide: true });
    const kv: Record<string, number> = {};
    for (const line of stdout.split('\n')) {
      const [k, v] = line.trim().split('=');
      if (k && v !== undefined) kv[k] = Number(v);
    }
    if (!(kv.WIDTH > 0) || !(kv.HEIGHT > 0) || !Number.isFinite(kv.X) || !Number.isFinite(kv.Y)) {
      return null;
    }
    const display = screen.getDisplayNearestPoint({
      x: kv.X + kv.WIDTH / 2,
      y: kv.Y + kv.HEIGHT / 2,
    });
    return {
      absLeft: Math.round(kv.X),
      absTop: Math.round(kv.Y),
      width: Math.round(kv.WIDTH),
      height: Math.round(kv.HEIGHT),
      displayId: display.id,
    };
  } catch {
    return null;
  }
}

// Capture a display region given in display-local (0,0 = display top-left)
// coordinates, at native physical resolution (see_screen feeds the model a
// full-res shot so annotation tags map 1:1 to real screen pixels).
async function captureDisplayRectLocal(
  localX: number,
  localY: number,
  width: number,
  height: number,
  displayId: number,
): Promise<{ b64: string; width: number; height: number } | null> {
  const allDisplays = screen.getAllDisplays();
  const display =
    allDisplays.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();

  if (isWindowsNativeCaptureSupported()) {
    const b64 = await captureDisplayRectNative(
      { x: localX, y: localY, width, height },
      displayId,
    );
    if (b64) {
      return {
        b64,
        width: Math.max(1, Math.round(width * display.scaleFactor)),
        height: Math.max(1, Math.round(height * display.scaleFactor)),
      };
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: display.size.width,
      height: display.size.height,
    },
  });
  if (sources.length === 0) return null;
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  const thumb = source.thumbnail;
  if (thumb.isEmpty()) return null;

  const size = thumb.getSize();
  const left = Math.max(0, Math.min(size.width - 1, Math.round(localX)));
  const top = Math.max(0, Math.min(size.height - 1, Math.round(localY)));
  const w = Math.max(1, Math.min(size.width - left, Math.round(width)));
  const h = Math.max(1, Math.min(size.height - top, Math.round(height)));

  // Keep the crop at native resolution — no resize, so image px == screen px.
  const cropped = thumb.crop({ x: left, y: top, width: w, height: h });
  const final = cropped.getSize();
  const jpegBuf = cropped.toJPEG(JPEG_QUALITY);
  return { b64: jpegBuf.toString('base64'), width: final.width, height: final.height };
}

// Capture an arbitrary screen region given in absolute physical pixels
// (primary-monitor origin — the same space click/move_mouse use) as a PNG
// base64 string. Used by the `paste_image` tool's region mode to capture part
// of the screen and paste it into a document.
export async function captureScreenRegionB64(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<string | null> {
  if (isWindowsNativeCaptureSupported()) {
    const b64 = await captureAbsoluteRectNative(rect);
    if (b64) return b64;
  }
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: display.size.width,
        height: display.size.height,
      },
    });
    if (sources.length === 0) return null;
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    const thumb = source.thumbnail;
    if (thumb.isEmpty()) return null;
    const size = thumb.getSize();
    const left = Math.max(0, Math.min(size.width - 1, Math.round(rect.x - display.bounds.x)));
    const top = Math.max(0, Math.min(size.height - 1, Math.round(rect.y - display.bounds.y)));
    const w = Math.max(1, Math.min(size.width - left, Math.round(rect.width)));
    const h = Math.max(1, Math.min(size.height - top, Math.round(rect.height)));
    const cropped = thumb.crop({ x: left, y: top, width: w, height: h });
    if (cropped.isEmpty()) return null;
    return cropped.toPNG().toString('base64');
  } catch {
    return null;
  }
}

// Capture the active window for the agent's `see_screen` tool. Returns the
// JPEG base64 plus a caption telling the model where the window sits on
// screen and the image dimensions (so click/move_mouse stay correct), plus
// the image→screen geometry the POINT protocol needs to map model-emitted
// image-pixel coordinates to absolute screen DIPs.
export async function captureActiveWindowForAgent(): Promise<{
  b64: string;
  caption: string;
  geo: import('../llm/point').PointGeo;
} | null> {
  const rect = await getActiveWindowRect();
  if (!rect) return null;
  const display = screen.getAllDisplays().find((d) => d.id === rect.displayId);
  if (!display) return null;
  const sf = display.scaleFactor || 1;
  // GetWindowRect returns PHYSICAL px (primary-monitor origin), but
  // captureDisplayRectLocal takes display-LOCAL LOGICAL px and scales by sf
  // itself. Feed it the logical rect, or a 125% display quadratically
  // overshoots the crop (the window shot came back 1.25x too big, which is the
  // only reason resizeImageMaxEdge ever kicked in here).
  const localX = rect.absLeft / sf - display.bounds.x;
  const localY = rect.absTop / sf - display.bounds.y;
  const widthDip = rect.width / sf;
  const heightDip = rect.height / sf;

  try {
    const shot = await captureDisplayRectLocal(localX, localY, widthDip, heightDip, rect.displayId);
    if (!shot) return null;
    const caption =
      `Fresh screenshot of the active window (${shot.width}×${shot.height}px). ` +
      `The window's top-left corner is at screen (${rect.absLeft}, ${rect.absTop}). ` +
      `click/move_mouse/scroll use the same absolute screen-pixel coordinate space.`;
    // Map the WINDOW crop into the CANONICAL full-display geometry: region is
    // where the window sits in the display's native physical pixel grid (so a
    // tag written in the crop's pixels lands on the exact screen pixel), and
    // cropSize is what the crop covers on screen. region.w/h stay the MODEL
    // image's dims (resizeImageMaxEdge may have downscaled it); when they
    // differ, regionCropScale un-resizes tags before the display mapping.
    const primary = screen.getPrimaryDisplay();
    const winLeft =
      process.platform === 'win32' ? rect.absLeft + primary.bounds.x * sf : rect.absLeft;
    const winTop =
      process.platform === 'win32' ? rect.absTop + primary.bounds.y * sf : rect.absTop;
    const regionX = Math.round(winLeft - display.bounds.x * sf);
    const regionY = Math.round(winTop - display.bounds.y * sf);
    const resizedB64 = resizeImageMaxEdge(shot.b64);
    const resizedImg = resizedB64 !== shot.b64
      ? (() => { try { return nativeImage.createFromBuffer(Buffer.from(resizedB64, 'base64')).getSize(); } catch { return null; } })()
      : null;
    const regionW = resizedImg?.width ?? shot.width;
    const regionH = resizedImg?.height ?? shot.height;
    return {
      b64: resizedB64,
      caption,
      geo: {
        imgW: Math.round(display.size.width * sf),
        imgH: Math.round(display.size.height * sf),
        absLeft: display.bounds.x,
        absTop: display.bounds.y,
        winW: display.size.width,
        winH: display.size.height,
        region: { x: regionX, y: regionY, w: regionW, h: regionH },
        cropSize: { w: shot.width, h: shot.height },
      },
    };
  } catch {
    return null;
  }
}

// Submit-time capture — the model sees the screen the moment the user enters
// their prompt, not the stale trigger-time crop around the cursor.

// Whole-display fresh capture taken AT SUBMIT. Fixes the case where the
// trigger-time crop pointed at the wrong window (e.g. a terminal beside the
// app the user is actually working in): the submitted turn now reflects what
// is on screen right now. Every Spirit overlay is content-protected, so the
// box never appears in the shot. Captured at the display's NATIVE physical
// pixel resolution: the model estimates coordinates 1:1 against real monitor
// pixels — no "estimate small then multiply up" round-trip that quietly
// inflates each pixel of model slop by the downsample ratio. The geometry note
// still reports the real decoded image dims, so mapping back to screen DIP is
// exact. Best-effort — returns null on any failure so callers fall back to
// the trigger capture.
export async function captureScreenForSubmit(displayId?: number | null): Promise<string | null> {
  try {
    const allDisplays = screen.getAllDisplays();
    const cursor = screen.getCursorScreenPoint();
    const cursorDisp = screen.getDisplayNearestPoint(cursor);
    // Prefer the display the overlay lives on (the app the user is actually
    // working in) over the CURRENT cursor display — the cursor can have moved
    // to another monitor while the box stayed open, and the model should see
    // the screen the user is interacting with.
    const disp =
      (displayId !== undefined && allDisplays.find((d) => d.id === displayId)) ||
      allDisplays.find((d) => d.id === cursorDisp.id) ||
      screen.getPrimaryDisplay();
    // Windows: whole-display capture in the GDI worker (native) — the submit
    // path never freezes the cursor either. desktopCapturer is the fallback.
    if (isWindowsNativeCaptureSupported()) {
      const b64 = await captureDisplayRectNative(
        { x: 0, y: 0, width: disp.size.width, height: disp.size.height },
        disp.id,
      );
      if (b64) {
        const { resized, nativeB64 } = resizeImageForLLM(b64);
        lastNativeB64 = nativeB64;
        return resized;
      }
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: disp.size.width, height: disp.size.height },
    });
    if (sources.length === 0) return null;
    const source =
      sources.find((s) => s.display_id === String(disp.id)) ?? sources[0];
    const thumb = source.thumbnail;
    if (thumb.isEmpty()) return null;
    // Keep the native thumbnail as-is — no downscale, so image px == monitor px.
    const rawB64 = thumb.toJPEG(JPEG_QUALITY).toString('base64');
    const { resized, nativeB64 } = resizeImageForLLM(rawB64);
    lastNativeB64 = nativeB64;
    return resized;
  } catch {
    return null;
  }
}
