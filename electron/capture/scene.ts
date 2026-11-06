// Screen → elements ("scene graph"), ported from the older spirit-aicursor
// approach (plan.md §4/§6): the active window's accessibility tree is walked
// into elements that each carry a STABLE id, a control type, a name, screen
// bounds and a click center (Windows: UIA walk; macOS: AX walk; Linux:
// OCR-only). OCR (tesseract) adds a second layer of visible-text words so
// labels the a11y tree misses are still findable. The model reasons over the
// element ids instead of guessing pixel coordinates.
//
// Ids are content-addressed (see stableElementId): hashing what the element IS
// (source + type + label) plus where it sits (center bucketed to a 16px cell)
// keeps the same element on the same id across re-walks. Positional `el3`
// values were unstable — one new OCR word shifted every later index and the
// model clicked the wrong element after a ui_read → ui_click re-walk.
//
// Coordinate space: the scene lives in the same absolute space click/move_mouse
// use (see agentUnitsPerDip): Windows UIA rects are PHYSICAL pixels in the
// SetCursorPos/GetWindowRect virtual-screen space; macOS AX rects are points
// (CGEvent space); Linux uses X11 root pixels (xdotool space). OCR word boxes
// (captured in display DIPs) are converted into that same space per platform.

import { desktopCapturer, nativeImage, screen } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runPowerShell } from './ps-worker';
import { getTesseractPath } from './tesseract';
import { resolveAgentTarget, agentTargetAppContext } from './app-context';
import { fetchPageText } from './page-fetch';
import { withOverlaysHidden } from '../windows/overlay';
import { walkAx, axRoleToType, axRoleClickable } from './ax-scene';
import { getActiveWindowRect } from './screenshot';

const execFileP = promisify(execFile);

// Find the display containing a point given in PHYSICAL virtual-screen
// coordinates. Electron's screen coordinates are DIPs relative to the primary
// monitor, so a physical point must be compared against each display's
// physical bounds (bounds + size, both scaled) — never fed straight into
// getDisplayNearestPoint.
// Units of the agent coordinate space per Electron DIP. click/move_mouse and
// the scene all agree on one absolute space per platform:
//   - Windows: PHYSICAL pixels (SetCursorPos / GetWindowRect space).
//   - Linux: X11 root pixels (xdotool mousemove/click space).
//   - macOS: points (CGEventCreateMouseEvent space, where Electron DIPs equal
//     points on every Retina setting).
export function agentUnitsPerDip(display: Electron.Display): number {
  if (process.platform === 'darwin') return 1;
  return display.scaleFactor || 1;
}

function displayForPhysicalPoint(x: number, y: number): Electron.Display {
  const displays = screen.getAllDisplays();
  const match = displays.find((d) => {
    const sf = d.scaleFactor || 1;
    const left = d.bounds.x * sf;
    const top = d.bounds.y * sf;
    const right = left + d.size.width * sf;
    const bottom = top + d.size.height * sf;
    return x >= left && x < right && y >= top && y < bottom;
  });
  return match ?? screen.getPrimaryDisplay();
}

export interface SceneElement {
  id: string;
  type: string;
  name: string;
  bounds: [number, number, number, number];
  center: [number, number];
  enabled: boolean;
  clickable: boolean;
  // `grounding` marks elements produced by the optional visual grounding
  // subsystem (OmniParser sidecar or GroundingDINO ONNX) — the same shape as
  // UIA/OCR elements, detected pixels instead of fixed UI text.
  source: 'uia' | 'ax' | 'ocr' | 'grounding';
}

export interface Scene {
  windowTitle: string;
  elements: SceneElement[];
  monitor: { width: number; height: number };
  // Fetched page text (webfetch) when the scene was built in 'web' mode: the
  // readable text of the browser's current page, with no screen positions.
  // When present, the tesseract OCR pass was skipped (webfetch is the primary
  // reading path for reading-only tasks; OCR still carries action tasks).
  pageText?: { url: string; text: string };
  // Set when no target window could be identified (e.g. no real app was ever
  // observed). formatScene returns this verbatim so the model gets guidance
  // instead of an empty list.
  unavailable?: string;
}

// Which text layer backs the scene:
//  - 'ocr': tesseract word boxes with screen coordinates (clickable targets).
//  - 'web': fetched page text (no coordinates). Used for READING tasks — the
//    user asked about the page, not to act on it. Falls back to OCR when there
//    is no browser page URL to fetch or the fetch fails.
export type SceneTextSource = 'web' | 'ocr';

// Content-addressed element id: `el` + 8 hex chars of sha256(source|type|label
// |18px-bucketed center). An element that keeps its label and position keeps
// its id across re-walks; anything new gets its own stable id. The label is
// lowercased/whitespace-normalized so OCR phrasing is stable turn to turn.
// Two elements landing in the same 16px cell are near-enough identical targets
// that sharing an id is harmless.
function stableElementId(
  source: string,
  type: string,
  name: string,
  center: [number, number],
): string {
  const bucket = `${Math.round(center[0] / 16)},${Math.round(center[1] / 16)}`;
  const label = name.replace(/\s+/g, ' ').toLowerCase();
  const digest = createHash('sha256')
    .update(`${source}|${type}|${label}|${bucket}`)
    .digest('hex')
    .slice(0, 8);
  return `el${digest}`;
}

// Action words that mark the user's request as "do something on screen".
// When the goal contains one, ui_read keeps the OCR word boxes (they carry
// coordinates the agent clicks); reading-only goals get the webfetched page
// text instead.
const ACTION_VERBS = new Set([
  'click', 'press', 'tap', 'double', 'type', 'write', 'enter', 'fill', 'input',
  'send', 'reply', 'submit', 'search', 'select', 'choose', 'scroll',
  'drag', 'drop', 'move', 'launch', 'open', 'close', 'quit', 'minimize',
  'maximize', 'restore', 'switch', 'play', 'pause', 'stop', 'start', 'set',
  'change', 'enable', 'disable', 'delete', 'remove', 'create', 'add', 'rename',
  'save', 'download', 'upload', 'copy', 'paste', 'cut', 'login', 'logout',
  'register', 'install', 'update', 'upgrade', 'cancel', 'confirm', 'accept',
  'dismiss', 'share', 'bookmark', 'pin', 'unpin', 'mute', 'unmute', 'zoom',
  'refresh', 'reload', 'highlight', 'like', 'follow', 'subscribe', 'purchase',
  'buy', 'checkout', 'order', 'skip', 'next', 'back', 'forward', 'navigate',
  'run', 'execute', 'approve', 'deny', 'request', 'grant', 'allow',
  'block', 'join', 'leave', 'export', 'import',
]);

export function isActionGoal(goal: string): boolean {
  if (!goal) return false;
  const lower = ` ${goal.toLowerCase()} `;
  for (const verb of ACTION_VERBS) {
    if (new RegExp(`\\b${verb}\\b`).test(lower)) return true;
  }
  return false;
}

// Which text layer a reading task should use: action requests (click, fill,
// download…) need OCR coordinates to act on; pure reading gets webfetch.
export function textSourceForGoal(goal: string): SceneTextSource {
  return isActionGoal(goal) ? 'ocr' : 'web';
}

const MAX_DEPTH = 5;
const MAX_ELEMENTS = 500;

const CLICKABLE_TYPES = new Set([
  'Button',
  'SplitButton',
  'MenuItem',
  'CheckBox',
  'RadioButton',
  'ComboBox',
  'TabItem',
  'Hyperlink',
  'ListItem',
  'TreeItem',
  'Edit',
  'SpinButton',
  'ScrollBar',
  'Thumb',
]);

const CONTAINER_TYPES = new Set([
  'Window',
  'Frame',
  'Pane',
  'Document',
  'Group',
  'TitleBar',
  'MenuBar',
]);

// Drop tesseract noise tokens (">", "G", "5)", "@", "┬⌐"...). Only meaningful
// words make it into the numbered list — otherwise junk fills the cap and
// real page content (buttons like "Download Now") gets pushed off the list.
function isUsefulOcrWord(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 40) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  const alnum = t.replace(/[^a-zA-Z0-9]/g, '').length;
  return alnum / t.length >= 0.5;
}

// Bounded breadth-first walk of a window's UIA tree (same limits as the old
// windows_uia.py). Runs in the persistent PowerShell worker where the
// UIAutomation assemblies are already loaded, so this is just a tree walk.
// The walk targets the USER's window by handle (recorded at trigger time, when
// the user's app is still foreground) — never GetForegroundWindow, because the
// overlay holds focus during the agent loop and would walk Spirit itself.
function uiaWalkScript(targetHwnd: number | null): string {
  const hwndRead =
    targetHwnd === null
      ? `$hwnd = [SpiritFG.Native]::GetForegroundWindow()`
      : `$hwnd = [IntPtr]::new([int64]${targetHwnd})`;
  return `
${hwndRead}
if ($hwnd -eq [IntPtr]::Zero) { [pscustomobject]@{ title = ''; elements = @() } | ConvertTo-Json -Depth 5 -Compress; return }
# Defensive: never walk the taskbar/desktop. If the target hwnd is an
# explorer-owned shell window, report an empty scene instead of a wall of
# tray buttons (which the model would happily "click").
$clsSb = New-Object System.Text.StringBuilder 256
[void][SpiritFG.Native]::GetClassName($hwnd, $clsSb, 256)
$cls = $clsSb.ToString()
if ($cls -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd','XamlExplorerHostIslandWindow','Progman','WorkerW','Shell_TrayTray')) {
  [pscustomobject]@{ title = ''; elements = @() } | ConvertTo-Json -Depth 5 -Compress; return
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($null -eq $root) { [pscustomobject]@{ title = ''; elements = @() } | ConvertTo-Json -Depth 5 -Compress; return }
$clickable = @('Button','SplitButton','MenuItem','CheckBox','RadioButton','ComboBox','TabItem','Hyperlink','ListItem','TreeItem','Edit','SpinButton','ScrollBar','Thumb')
$out = New-Object System.Collections.Generic.List[object]
$title = ''
try { $title = [string]$root.Current.Name } catch { }
$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue([pscustomobject]@{ Element = $root; Depth = 0 })
$cond = [System.Windows.Automation.Condition]::TrueCondition
while ($queue.Count -gt 0 -and $out.Count -lt ${MAX_ELEMENTS}) {
  $item = $queue.Dequeue()
  $el = $item.Element
  $depth = $item.Depth
  if ($depth -gt ${MAX_DEPTH}) { continue }
  try {
    $b = $el.Current.BoundingRectangle
    if ($b.Width -gt 0 -and $b.Height -gt 0) {
      $type = ([string]$el.Current.ControlType.ProgrammaticName) -replace '^ControlType\\.',''
      $name = ([string]$el.Current.Name).Trim()
      $left = [int][Math]::Round($b.Left); $top = [int][Math]::Round($b.Top)
      $right = [int][Math]::Round($b.Right); $bottom = [int][Math]::Round($b.Bottom)
      $out.Add([pscustomobject]@{
        type = $type
        name = $name
        bounds = @($left, $top, $right, $bottom)
        center = @([int][Math]::Round(($left + $right) / 2), [int][Math]::Round(($top + $bottom) / 2))
        enabled = [bool]$el.Current.IsEnabled
        clickable = $clickable -contains $type
      })
    }
  } catch { }
  if ($depth -lt ${MAX_DEPTH}) {
    try {
      $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
      foreach ($child in $children) {
        if ($out.Count -ge ${MAX_ELEMENTS}) { break }
        $queue.Enqueue([pscustomobject]@{ Element = $child; Depth = $depth + 1 })
      }
    } catch { }
  }
}
[pscustomobject]@{ title = $title; elements = $out } | ConvertTo-Json -Depth 5 -Compress
`;
}

interface UiaRawElement {
  type: string;
  name: string;
  bounds: number[];
  center: number[];
  enabled: boolean;
  clickable: boolean;
}

interface UiaRawScene {
  title: string;
  elements: UiaRawElement[];
}

// A word read by tesseract, with its box in the PIXELS OF THE BUFFER IT WAS
// RUN ON (not screen coordinates — callers map to whatever space they need).
export interface OcrWord {
  text: string;
  bounds: [number, number, number, number];
  conf: number;
}

// Preprocess a nativeImage for OCR: grayscale + contrast stretch, upscaling
// small crops so tesseract can read them. Returns a PNG buffer.
export function preprocessForOcr(img: Electron.NativeImage): Buffer {
  const sz = img.getSize();
  const maxDim = Math.max(sz.width, sz.height);
  let work = img;
  if (maxDim < 300 && maxDim > 0) {
    const scale = Math.min(2, Math.ceil(300 / maxDim));
    work = img.resize({ width: sz.width * scale, height: sz.height * scale, quality: 'best' });
  }
  // Grayscale + contrast stretch
  let bitmap = work.toBitmap();
  const { width: w, height: h } = work.getSize();
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < bitmap.length; i += 4, j++) {
    gray[j] = (0.299 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i + 2]) | 0;
  }
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let lo = 0, hi = 255, cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum / total > 0.01) { lo = v; break; } }
  cum = 0;
  for (let v = 255; v >= 0; v--) { cum += hist[v]; if (cum / total > 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < bitmap.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, ((gray[j] - lo) / range) * 255)) | 0;
    bitmap[i] = v; bitmap[i + 1] = v; bitmap[i + 2] = v;
  }
  return nativeImage.createFromBuffer(bitmap, { width: w, height: h }).toPNG();
}

// Run tesseract (TSV) over a preprocessed PNG buffer and return the word boxes
// in buffer-pixel coordinates. Returns [] when tesseract is unavailable, the
// buffer is empty, or nothing readable was found.
export async function ocrWordsFromPngBuffer(pngBuf: Buffer): Promise<OcrWord[]> {
  const tesseract = getTesseractPath();
  if (!tesseract || !pngBuf || pngBuf.length === 0) return [];
  const tmpFile = join(tmpdir(), `spirit-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await writeFile(tmpFile, pngBuf);
    const { stdout } = await execFileP(
      tesseract,
      [tmpFile, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6', '-c', 'preserve_interword_spaces=1', 'tsv'],
      { timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '2', OMP_NUM_THREADS: '2' } },
    );
    const words: OcrWord[] = [];
    const lines = stdout.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols.length < 12 || cols[0] !== '5') continue;
      const conf = Number(cols[10]);
      const text = (cols[11] ?? '').trim();
      if (!text || !Number.isFinite(conf) || conf < 30) continue;
      if (!isUsefulOcrWord(text)) continue;
      const x = Number(cols[6]);
      const y = Number(cols[7]);
      const bw = Number(cols[8]);
      const bh = Number(cols[9]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(bw) || !Number.isFinite(bh)) continue;
      if (bw <= 0 || bh <= 0) continue;
      words.push({ text, bounds: [x, y, x + bw, y + bh], conf });
    }
    return words;
  } catch {
    return [];
  } finally {
    void rm(tmpFile, { force: true }).catch(() => {});
  }
}

async function walkUia(targetHwnd: number | null): Promise<UiaRawScene> {
  if (process.platform !== 'win32') return { title: '', elements: [] };
  const raw = await runPowerShell(uiaWalkScript(targetHwnd), 15000);
  const parsed = JSON.parse(raw) as UiaRawScene;
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    elements: Array.isArray(parsed.elements) ? parsed.elements : [],
  };
}

// Capture the window's screen region (display DIPs) and run tesseract over it,
// returning word boxes converted to physical virtual-screen coordinates.
async function ocrElements(
  windowRect: [number, number, number, number] | null,
  uiaElements: SceneElement[],
): Promise<SceneElement[]> {
  const tesseract = getTesseractPath();
  if (!windowRect || !tesseract) return [];
  const [wl, wt, wr, wb] = windowRect;
  const w = wr - wl;
  const h = wb - wt;
  if (w < 4 || h < 4) return [];
  const cx = (wl + wr) / 2;
  const cy = (wt + wb) / 2;
  const display = displayForPhysicalPoint(cx, cy);
  const sf = agentUnitsPerDip(display);

  // Window rect (physical) → crop rect within this display (DIPs).
  const cropLeft = Math.round(wl / sf - display.bounds.x);
  const cropTop = Math.round(wt / sf - display.bounds.y);
  const cropW = Math.max(1, Math.round(w / sf));
  const cropH = Math.max(1, Math.round(h / sf));
  if (cropW < 4 || cropH < 4) return [];

  const allDisplays = screen.getAllDisplays();
  const disp = allDisplays.find((d) => d.id === display.id) ?? screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: disp.size.width, height: disp.size.height },
  });
  if (sources.length === 0) return [];
  const source = sources.find((s) => s.display_id === String(disp.id)) ?? sources[0];
  const thumb = source.thumbnail;
  if (thumb.isEmpty()) return [];

  const size = thumb.getSize();
  const left = Math.max(0, Math.min(size.width - 1, cropLeft));
  const top = Math.max(0, Math.min(size.height - 1, cropTop));
  const width = Math.max(1, Math.min(size.width - left, cropW));
  const height = Math.max(1, Math.min(size.height - top, cropH));

  const cropped = thumb.crop({ x: left, y: top, width, height });
  // Preprocess for OCR: grayscale + contrast boost + upscale small crops.
  const pngBuf = preprocessForOcr(cropped);
  if (pngBuf.length === 0) return [];

  const words = await ocrWordsFromPngBuffer(pngBuf);
  if (words.length === 0) return [];

  // Crop origin in physical virtual-screen coordinates.
  const physOx = Math.round((display.bounds.x + left) * sf);
  const physOy = Math.round((display.bounds.y + top) * sf);

  // Cluster words into phrases so buttons/labels read naturally and far more
  // of the page fits the numbered list. "Download" + "Now" on a button
  // become ONE element, not two fragments the model has to piece together.
  const phrases = clusterWords(words);

  const elements: SceneElement[] = [];
  for (const phrase of phrases) {
    const [bx1, by1, bx2, by2] = phrase.bounds;
    const pb: [number, number, number, number] = [
      physOx + Math.round(bx1 * sf),
      physOy + Math.round(by1 * sf),
      physOx + Math.round(bx2 * sf),
      physOy + Math.round(by2 * sf),
    ];
    if (coveredByUia(uiaElements, phrase.text, pb)) continue;
    const center: [number, number] = [
      Math.round((pb[0] + pb[2]) / 2),
      Math.round((pb[1] + pb[3]) / 2),
    ];
    elements.push({
      id: stableElementId('ocr', 'text', phrase.text, center),
      type: 'text',
      name: phrase.text,
      bounds: pb,
      center,
      enabled: true,
      clickable: false,
      source: 'ocr',
    });
  }
  return elements;
}

// Group OCR words on the same text row into phrases: "Download Now" stays one
// numbered target instead of two fragments. Words on the same row that are far
// apart (different columns) become separate phrases.
export function clusterWords(
  words: { text: string; bounds: [number, number, number, number] }[],
): { text: string; bounds: [number, number, number, number] }[] {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
  const rows: { text: string; bounds: [number, number, number, number] }[][] = [];
  for (const w of sorted) {
    const cy = (w.bounds[1] + w.bounds[3]) / 2;
    const row = rows.find((r) => {
      let top = Infinity;
      let bottom = -Infinity;
      for (const x of r) {
        top = Math.min(top, x.bounds[1]);
        bottom = Math.max(bottom, x.bounds[3]);
      }
      return cy >= top && cy <= bottom;
    });
    if (row) row.push(w);
    else rows.push([w]);
  }
  const phrases: { text: string; bounds: [number, number, number, number] }[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bounds[0] - b.bounds[0]);
    let cur: { text: string; bounds: [number, number, number, number] } = {
      text: row[0].text,
      bounds: [...row[0].bounds],
    };
    for (let i = 1; i < row.length; i++) {
      const gap = row[i].bounds[0] - cur.bounds[2];
      const width = cur.bounds[2] - cur.bounds[0];
      if (gap <= Math.max(10, width * 0.5)) {
        cur.text += ' ' + row[i].text;
        cur.bounds = [
          Math.min(cur.bounds[0], row[i].bounds[0]),
          Math.min(cur.bounds[1], row[i].bounds[1]),
          Math.max(cur.bounds[2], row[i].bounds[2]),
          Math.max(cur.bounds[3], row[i].bounds[3]),
        ];
      } else {
        phrases.push(cur);
        cur = { text: row[i].text, bounds: [...row[i].bounds] };
      }
    }
    phrases.push(cur);
  }
  return phrases;
}

function rectIntersects(a: number[], b: number[]): boolean {
  return !(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]);
}

// Skip an OCR word when the same text is already exposed by a nearby
// non-container UIA element (mirrors _covered_by_uia in the old scene.py).
function coveredByUia(uiaElements: SceneElement[], text: string, bounds: number[]): boolean {
  const needle = text.toLowerCase();
  for (const el of uiaElements) {
    if (CONTAINER_TYPES.has(el.type)) continue;
    const haystack = `${el.name} ${el.type}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    if (rectIntersects(el.bounds, bounds)) return true;
  }
  return false;
}

// Build the full scene: accessibility walk first (Windows UIA / macOS AX), then
// a text layer. The text layer is chosen by the caller:
//  - 'web' (default for ui_read READING tasks): fetch the browser page's text
//    via webfetch and skip tesseract entirely — faster and far more accurate
//    than OCR-ing a browser screenshot. Falls back to OCR when the target is
//    not a browser with a fetchable URL, or the fetch fails.
//  - 'ocr' (action tasks, ui_click/drag/goal-click): tesseract word boxes with
//    screen coordinates, fused after the a11y walk.
// Linux has no in-process a11y walk — the scene is OCR-only unless webfetch
// applies. Element ids are content-addressed (stableElementId), so a target
// read by ui_read still resolves to the same element when ui_click re-walks
// (as long as the window didn't change).
export async function buildScene(
  opts: { textSource?: SceneTextSource; noText?: boolean } = {},
): Promise<Scene> {
  // Act on the USER's window (recorded at trigger time), not the overlay that
  // holds focus while the box is open.
  const target = resolveAgentTarget();
  if (target.id === null) {
    console.warn('[scene] no target window to read — no user app recorded yet');
    return {
      windowTitle: '',
      elements: [],
      monitor: monitorSize(),
      unavailable:
        'Could not identify the active window to read (no user app in the foreground yet). ' +
        'Use see_screen() to look at the screen, then click/move_mouse by pixel.',
    };
  }

  let title = '';
  let uia: SceneElement[] = [];
  let windowRect: [number, number, number, number] | null = null;

  if (process.platform === 'win32') {
    const raw = await walkUia(target.id);
    title = raw.title;
    uia = raw.elements.map((el) => {
      const center: [number, number] = [
        Math.round(el.center[0] ?? 0),
        Math.round(el.center[1] ?? 0),
      ];
      return {
        id: stableElementId('uia', el.type || 'unknown', el.name || '', center),
        type: el.type || 'unknown',
        name: el.name || '',
        bounds: [
          Math.round(el.bounds[0] ?? 0),
          Math.round(el.bounds[1] ?? 0),
          Math.round(el.bounds[2] ?? 0),
          Math.round(el.bounds[3] ?? 0),
        ],
        center,
        enabled: !!el.enabled,
        clickable: !!el.clickable,
        source: 'uia',
      };
    });
    windowRect = uia.find((e) => e.type === 'Window')?.bounds ?? null;
  } else if (process.platform === 'darwin') {
    if (target.pid) {
      const ax = await walkAx(target.pid);
      title = ax.title;
      uia = ax.elements.map((el) => ({
        id: stableElementId('ax', axRoleToType(el.role), el.name || '', el.center),
        type: axRoleToType(el.role),
        name: el.name || '',
        bounds: el.bounds,
        center: el.center,
        enabled: el.enabled,
        clickable: axRoleClickable(el.role),
        source: 'ax',
      }));
      windowRect = uia.find((e) => e.type === 'Window')?.bounds ?? null;
    }
    if (!windowRect) {
      const rect = await getActiveWindowRect();
      if (rect) windowRect = [rect.absLeft, rect.absTop, rect.absLeft + rect.width, rect.absTop + rect.height];
    }
  } else if (process.platform === 'linux') {
    const rect = await getActiveWindowRect();
    if (rect) windowRect = [rect.absLeft, rect.absTop, rect.absLeft + rect.width, rect.absTop + rect.height];
  }

  let ocr: SceneElement[] = [];
  let pageText: { url: string; text: string } | undefined;

  if (!opts.noText && opts.textSource === 'web') {
    // Reading mode: webfetch the page text first. Only browsers have a page
    // URL, so "browser present" == "http(s) url known".
    const app = agentTargetAppContext();
    const url = app.url.trim();
    if (/^https?:\/\//i.test(url)) {
      try {
        const text = await fetchPageText(url, { timeoutMs: 8000 });
        if (text.trim().length > 0) {
          pageText = { url, text };
        }
      } catch (err) {
        console.warn(
          `[scene] webfetch failed for ${url} — falling back to OCR: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // OCR is the fallback text layer: not requested, not in a browser, or the
  // fetch failed/returned nothing. `noText` (see_screen's element map) skips
  // it — the fresh screenshot is already OCR'd by the tool itself.
  if (!opts.noText && !pageText && windowRect) {
    try {
      ocr = await withOverlaysHidden(() => ocrElements(windowRect, uia));
    } catch {
      /* OCR is best-effort */
    }
  }

  const primary = screen.getPrimaryDisplay();
  const psf = agentUnitsPerDip(primary);
  console.log(
    `[scene] platform=${process.platform} id=${target.id} text=${pageText ? `web(${pageText.text.length})` : `ocr(${ocr.length})`} window="${title || ''}" a11y=${uia.length} total=${uia.length + ocr.length}`,
  );
  return {
    windowTitle: title || '',
    elements: [...uia, ...ocr],
    monitor: monitorSize(),
    pageText,
  };
}

function monitorSize(): { width: number; height: number } {
  const primary = screen.getPrimaryDisplay();
  const psf = agentUnitsPerDip(primary);
  return {
    width: Math.round(primary.size.width * psf),
    height: Math.round(primary.size.height * psf),
  };
}

function isInteresting(el: SceneElement): boolean {
  if (el.source === 'ocr') return true;
  if (CONTAINER_TYPES.has(el.type)) return false;
  const [x1, y1, x2, y2] = el.bounds;
  if (x2 - x1 < 2 || y2 - y1 < 2) return false;
  return el.clickable || el.type === 'Edit' || el.type === 'Text';
}

// Goal-matching for the click-targets menu: extract the meaningful tokens
// from a user's request ("click download now" → ["download"]) so the short
// menu can surface elements whose label matches the goal FIRST. Action and
// function words are dropped — they describe HOW, not WHAT.
const GOAL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'please', 'could', 'would',
  'should', 'click', 'press', 'tap', 'open', 'find', 'look', 'get', 'grab',
  'make', 'set', 'put', 'take', 'want', 'need', 'can', 'this', 'that',
  'there', 'here', 'button', 'link', 'tab', 'page', 'now', 'just', 'then',
  'also', 'have', 'has', 'from', 'into', 'after', 'before', 'about', 'what',
  'when', 'where', 'which', 'some', 'any', 'one', 'two', 'very', 'will',
  'going', 'downloads', 'internet', 'browser',
]);

// Meaningful tokens from a goal string, e.g. "click Download Now please"
// → ["download"]. Lowercased, deduped, stopwords removed.
export function goalTokens(goal: string): string[] {
  const words = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  return [...new Set(words)].filter((w) => !GOAL_STOPWORDS.has(w));
}

// How well an element label matches the goal tokens (0 = no overlap). A WHOLE
// word match counts 1 ("download" in "Download Now"); a substring inside a
// longer word counts 0.5 ("download" inside Arc's "downloadButton" toolbar
// icon) so it still ranks ahead of unrelated labels but never ties with the
// exact match the user asked for.
export function goalScoreFor(name: string, tokens: string[]): number {
  const n = name.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (new RegExp(`\\b${escapeRegExp(t)}\\b`).test(n)) score += 1;
    else if (n.includes(t)) score += 0.5;
  }
  return score;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the short "best click targets" menu for a scene: the handful of items
// a task is most likely to need, so a weak model sees its target in the first
// few lines instead of hunting through a 60-line list. Short OCR phrases
// (button/label-like) come first, then named clickable UIA elements. When a
// goal is given, elements whose label matches the goal words rank FIRST (more
// specific — longer — labels break ties), so e.g. "Download Now" beats the
// nav-bar "Download" link and Arc's "downloadButton" icon.
export function buildClickTargetsMenu(scene: Scene, limit = 6, goal?: string): SceneElement[] {
  const ocr = scene.elements.filter((e) => {
    if (e.source !== 'ocr') return false;
    const t = e.name.trim();
    if (t.length < 3 || t.length > 24) return false;
    // Skip anything that reads like prose (ends a sentence) or is junk.
    if (/[.,;:!?…]$/.test(t)) return false;
    return true;
  });
  const namedUia = scene.elements.filter(
    (e) =>
      (e.source === 'uia' || e.source === 'ax') &&
      e.clickable &&
      e.name.trim().length > 0 &&
      e.name !== '(unnamed icon)',
  );
  const all = [...ocr, ...namedUia];
  let ordered = all;
  const tokens = goal && goal.trim() ? goalTokens(goal) : [];
  if (tokens.length > 0) {
    // Sort by relevance: goal-token hits first. Ties prefer what the user
    // SEES — OCR labels over UIA chrome names — then the longer (more
    // specific) label ("Download Now" beats the nav "Download"), then scene
    // order. So a weak model sees "Download Now" ahead of Arc's
    // "downloadButton" toolbar icon.
    ordered = [...all].sort((a, b) => {
      const sa = goalScoreFor(a.name, tokens);
      const sb = goalScoreFor(b.name, tokens);
      if (sa !== sb) return sb - sa;
      const srcA = a.source === 'ocr' ? 0 : 1;
      const srcB = b.source === 'ocr' ? 0 : 1;
      if (srcA !== srcB) return srcA - srcB;
      if (a.name.length !== b.name.length) return b.name.length - a.name.length;
      return all.indexOf(a) - all.indexOf(b);
    });
  }
  const seen = new Set<string>();
  const out: SceneElement[] = [];
  for (const el of ordered) {
    const key = el.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
    if (out.length >= limit) break;
  }
  return out;
}

// Render the scene as a numbered, copy-paste-ready list for the model.
// The DISPLAY list is reordered but each row keeps its RAW (stable) element
// id, so ui_click("elN") still resolves to the same element on a fresh walk.
export function formatScene(scene: Scene, shownLimit = 70): string {
  if (scene.unavailable) return scene.unavailable;
  const uiaInteresting = scene.elements.filter(
    (e) => (e.source === 'uia' || e.source === 'ax') && isInteresting(e),
  );
  const ocrWords = scene.elements.filter((e) => e.source === 'ocr');
  // Page text first: in browsers the page content is rarely exposed to UIA
  // (Arc's tree is mostly chrome — back/forward/sidebar/tabs), so those words
  // are what the model can actually act on. Cap OCR so the useful page words
  // are guaranteed on screen instead of being pushed out by chrome controls.
  const ocrCap = Math.min(45, Math.floor(shownLimit * 0.6));
  const ordered = [...ocrWords.slice(0, ocrCap), ...uiaInteresting];
  const shown = ordered.slice(0, shownLimit);
  const lines: string[] = [];
  lines.push(`Active window: ${scene.windowTitle || '(unknown)'}`);
  lines.push('');
  if (shown.length === 0) {
    lines.push(
      'No interactive elements found for this window. The app may not expose buttons to the ' +
        'accessibility tree (games, canvas-heavy pages, video players). Fall back to see_screen() ' +
        'and click(x, y) by pixel.',
    );
  } else {
    lines.push('Elements you can act on (each has a number — click it with ui_click, e.g. ui_click("el3")):');
    lines.push('');
    for (const el of shown) {
      const label = el.name || (el.type === 'text' ? el.id : '(unnamed icon)');
      const tag = el.clickable ? el.type : el.source === 'ocr' ? 'text' : el.type;
      lines.push(`${el.id}  ${tag}  "${label}"  center (${el.center[0]}, ${el.center[1]})`);
    }
    const hidden = ordered.length - shown.length;
    if (hidden > 0) {
      lines.push('');
      lines.push(
        `…and ${hidden} more. If the target you need isn't in this list, the page may need scrolling — ` +
          `scroll, then call ui_read() again for a fresh list.`,
      );
    }
    lines.push('');
    lines.push(
      'Prefer clicking a real button/link by its number. Use pixel coordinates only when no numbered element matches.',
    );
  }
  // Fetched page text (web mode): the readable content of the current page,
  // with no screen positions — for READING the page, not for clicking it.
  if (scene.pageText) {
    lines.push('');
    lines.push(`PAGE CONTENT (fetched from ${scene.pageText.url}):`);
    lines.push(scene.pageText.text);
    lines.push('');
    lines.push(
      'The page text above was fetched from the site, so it has no screen positions. To click a page ' +
        'item, use see_screen() for the screenshot and click(x, y) by pixel. The numbered elements are ' +
        'the browser window controls (tabs, back, address bar).',
    );
  }
  return lines.join('\n');
}

// Compact numbered element map for a caption (see_screen), NOT the full
// ui_read list: real UIA/AX frames first (exact bounds), then OCR word boxes,
// capped so it rides along in a tool caption without drowning it. Empty when
// the window exposes nothing usable — callers simply skip the block.
export function formatQuickElementMap(scene: Scene, limit = 14): string {
  if (scene.unavailable || scene.elements.length === 0) return '';
  const rows: string[] = [];
  const seen = new Set<string>();
  const push = (el: SceneElement): void => {
    if (rows.length >= limit) return;
    const label = (el.name || el.id).trim().replace(/\s+/g, ' ');
    const key = `${el.id}\t${el.type}\t${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    const short = label.length > 40 ? `${label.slice(0, 40)}…` : label;
    rows.push(`${el.id} ${el.type} "${short}" at (${el.center[0]}, ${el.center[1]})`);
  };
  for (const el of scene.elements) {
    if (el.source === 'ocr') continue;
    if (isInteresting(el)) push(el);
  }
  for (const el of scene.elements) {
    if (el.source !== 'ocr') continue;
    push(el);
  }
  return rows.join('\n');
}

// Resolve a ui_click argument (number or "el…" string) to a scene element.
// Ids now are content-addressed hex (`el3f9a2b1c`) — match the id STRING
// first, wherever it sits in the list. Numeric-looking strings still fall
// back to positional index (the weak fallback model keeps emitting "el0",
// "el3" from stale reads), and a bare number is positional too.
export function resolveElementById(
  elements: SceneElement[],
  id: unknown,
): SceneElement | undefined {
  let target: SceneElement | undefined;
  if (typeof id === 'number') {
    target = elements[Math.floor(id)] ?? undefined;
  } else if (typeof id === 'string') {
    const s = id.trim();
    const m = /^el([0-9a-z]+)$/i.exec(s);
    if (m) {
      target = elements.find((e) => e.id === s);
      if (!target) {
        const pos = Number(m[1]);
        if (Number.isInteger(pos)) target = elements[pos] ?? undefined;
      }
    } else if (/^\d+$/.test(s)) {
      target = elements[Number(s)] ?? undefined;
    } else {
      target = elements.find((e) => e.name === s);
    }
  }
  if (!target) return undefined;
  // Never click a container element: the window root (el0), frames, panes and
  // groups wrap content but have no actionable surface — clicking them just
  // hits whatever happens to sit at the window's center. Containers are never
  // shown in the ui_read list, so a number pointing at one is a hallucination
  // (the weak fallback model keeps inventing "el0") and must error instead of
  // producing a "successful" click on the wrong spot.
  if (CONTAINER_TYPES.has(target.type)) return undefined;
  return target;
}
