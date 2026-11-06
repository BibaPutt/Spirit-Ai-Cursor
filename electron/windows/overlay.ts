import { BrowserWindow, app, screen, shell, type Display } from 'electron';
import { join } from 'node:path';
import { hideMacTrafficLights } from './macTrafficLights';
import { getAppIconPathSync } from '../tray/icon';

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// Sandbox the renderer in packaged builds. Dev keeps sandbox:false because
// Vite's HMR client needs Node module access in the renderer process. In
// production the renderer only loads bundled JS through preload, so the
// sandbox restricts attack surface without breaking functionality. The
// preload itself uses only contextBridge/ipcRenderer which work in sandboxed
// renderers (no node:fs or similar imports).
const ENABLE_SANDBOX = app.isPackaged;

const overlayWindows = new Map<number, BrowserWindow>();

// Ghost-mode state. Defaults match the pre-ghost behavior (capture-protected
// + hidden from the taskbar), and new overlays pick up the latest values.
let contentProtectionEnabled = true;
let skipTaskbarEnabled = true;

// Reserve a tiny strip at the very bottom of the screen so an auto-hide
// taskbar (Windows + most Linux DEs) can still detect the cursor and
// reappear. Without this the overlay covers the trigger zone and the
// taskbar never comes back while Spirit is loaded. Reported as
// GitHub #1 by @louisagung. macOS uses the menu bar at the top and has
// its own auto-hide logic that doesn't conflict with our overlay, so
// the gap is zero there.
const TASKBAR_TRIGGER_GAP_PX = process.platform === 'darwin' ? 0 : 2;

export function createOverlayForDisplay(display: Display): BrowserWindow {
  const win = new BrowserWindow({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: Math.max(0, display.workArea.height - TASKBAR_TRIGGER_GAP_PX),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    icon: getAppIconPathSync() || undefined,
    skipTaskbar: skipTaskbarEnabled,
    // Always focusable so the DOM input inside the box can receive keyboard
    // focus. We used to flip this on/off per hover via setFocusable() — that
    // call repaints the macOS window frame and was a major contributor to
    // the flicker the user was seeing. The `panel` type already keeps this
    // window from stealing focus from the underlying app, so leaving focusable
    // permanently on is safe.
    focusable: true,
    show: false,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    // titleBarStyle: 'hiddenInset' on macOS so we can additionally call
    // setWindowButtonPosition to park the buttons off-screen as defense
    // in depth. Without a hidden titlebar that API throws. On Windows /
    // Linux this option is a no-op.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: ENABLE_SANDBOX,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  // When set to true, overlays are excluded from screen capture (SetWindowDisplayAffinity
  // WDA_EXCLUDEFROMCAPTURE / NSWindowSharingNone). Setting to false allows Spirit to be
  // captured in screenshots and screen recordings. Linux has no equivalent API.
  win.setContentProtection(contentProtectionEnabled);

  // Aggressively suppress the macOS traffic-light buttons across all the
  // events where AppKit might re-create them. The single-shot call we had
  // in v1.0.0 worked most of the time but occasionally leaked a one-frame
  // flash of buttons at top-left on macOS 14 — visible to the user as
  // "the 3 dots from the invisible window". The helper re-applies on
  // ready-to-show, focus/blur, fullscreen transitions, devtools, AND
  // parks the button position at (-1000, -1000) as a final fallback.
  hideMacTrafficLights(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Defense in depth: prevent any in-frame navigation. The renderer is
  // expected to live entirely on the bundled index.html (file://) in prod or
  // on the local Vite dev server in dev. Any other URL navigation attempt is
  // either a bug or a successful injection; either way we refuse and route
  // through openExternal for http(s) destinations.
  win.webContents.on('will-navigate', (event, url) => {
    const allowed =
      (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) ||
      url.startsWith('file://');
    if (allowed) return;
    event.preventDefault();
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
  });

  // Likewise block redirects within the same webContents that try to leave
  // the bundled app surface.
  win.webContents.on('will-redirect', (event, url) => {
    const allowed =
      (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) ||
      url.startsWith('file://');
    if (allowed) return;
    event.preventDefault();
  });

  let shown = false;
  const safeShow = () => {
    if (shown) return;
    shown = true;
    try { win.showInactive(); } catch { /* ignore */ }
  };

  win.once('ready-to-show', safeShow);

  // Fallback: if ready-to-show never fires (GPU glitch, Vite HMR hiccup,
  // etc.) force-show after 3 s so the overlay is never invisible.
  setTimeout(safeShow, 3_000);

  // While DevTools is open we drop alwaysOnTop on every overlay, otherwise
  // the screen-saver-level overlay covers the DevTools window and clicks
  // there land on the (mostly transparent) overlay instead of the DevTools
  // UI. That made DevTools effectively unusable. Listening per webContents
  // is fine because both overlay-attached and detached DevTools fire these
  // events.
  win.webContents.on('devtools-opened', () => {
    setAllOverlaysAlwaysOnTop(false);
  });
  win.webContents.on('devtools-closed', () => {
    setAllOverlaysAlwaysOnTop(true);
  });

  // Forward renderer [tts] logs to the main-process terminal so TTS debugging
  // doesn't require opening DevTools. Other renderer output (React, flicker)
  // is intentionally not forwarded to keep the terminal readable.
  win.webContents.on('console-message', (_e, level, message, line) => {
    if (!message.includes('[tts]')) return;
    const out = `[renderer]${line ? `:${line}` : ''} ${message}`;
    // level: 0 verbose, 1 info, 2 warning, 3 error
    if (level === 3) console.error(out);
    else if (level === 2) console.warn(out);
    else console.log(out);
  });

  const isPrimary = display.id === screen.getPrimaryDisplay().id ? '1' : '0';
  const query = `?displayId=${display.id}&primary=${isPrimary}`;
  if (VITE_DEV_SERVER_URL) {
    const devUrl = `${VITE_DEV_SERVER_URL}${query}`;
    win.loadURL(devUrl).catch((err) => {
      console.warn(`[overlay] display=${display.id} loadURL failed, retrying in 1s:`, err?.message ?? err);
      setTimeout(() => { if (!win.isDestroyed()) win.loadURL(devUrl).catch(() => { }); }, 1_000);
    });
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      query: { displayId: String(display.id), primary: isPrimary },
    });
  }

  overlayWindows.set(display.id, win);

  win.on('closed', () => {
    overlayWindows.delete(display.id);
    interactiveState.delete(display.id);
    clickThroughRefCount.delete(display.id);
  });

  return win;
}

export function createOverlayForAllDisplays(): BrowserWindow[] {
  return screen.getAllDisplays().map(createOverlayForDisplay);
}

export function getOverlayForDisplay(displayId: number): BrowserWindow | undefined {
  return overlayWindows.get(displayId);
}

export function getAllOverlays(): BrowserWindow[] {
  return Array.from(overlayWindows.values());
}

// Ghost mode: exclude every overlay from screen capture. No-op on Linux,
// where neither Electron nor the native window layer exposes this.
export function setContentProtectionEnabled(enabled: boolean): void {
  contentProtectionEnabled = enabled;
  for (const win of overlayWindows.values()) {
    if (!win.isDestroyed()) win.setContentProtection(enabled);
  }
}

// Ghost mode sub-toggle: hide/show the overlay in the taskbar (Windows/Linux)
// and the Dock's window list (macOS).
export function setOverlaysSkipTaskbar(skip: boolean): void {
  skipTaskbarEnabled = skip;
  for (const win of overlayWindows.values()) {
    if (!win.isDestroyed()) win.setSkipTaskbar(skip);
  }
}

export function getOverlayEntries(): Array<[number, BrowserWindow]> {
  return Array.from(overlayWindows.entries());
}

// Sleep/wake recovery. After suspend/resume the OS may demote always-on-top,
// drop visible-on-all-workspaces, move windows across changed displays, or
// leave the compositor with a dead frame — the user saw the box "gone
// forever" after wake. Called once on powerMonitor resume: re-asserts level,
// workspace visibility, bounds, and interactive state per window, and nudges
// visible windows through hide/showInactive for a fresh frame. showInactive
// never steals focus from whatever the user had open.
export function restoreOverlaysAfterWake(): void {
  console.log('[overlay] system resume — restoring overlays');
  let displays: Display[] = [];
  try {
    displays = screen.getAllDisplays();
  } catch {
    /* screen unavailable — restore in place */
  }
  for (const [displayId, win] of getOverlayEntries()) {
    if (win.isDestroyed()) continue;
    try {
      const display =
        displays.find((d) => d.id === displayId) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      win.setBounds({
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: Math.max(0, display.workArea.height - TASKBAR_TRIGGER_GAP_PX),
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.moveTop();
      applyInteractiveState(displayId);
      if (win.isVisible()) {
        win.hide();
        win.showInactive();
      }
    } catch (err) {
      console.warn('[overlay] wake restore failed:', err instanceof Error ? err.message : err);
    }
  }
}

// Per-window cache of the most recently applied interactive state. Without
// this we'd call setIgnoreMouseEvents/setFocusable/focus/blur on every
// renderer tick — and on macOS each of those triggers a window-frame repaint.
// The user saw that as the box "flickering" on hover and drag. We now no-op
// when the state hasn't actually changed.
const interactiveState = new Map<number, boolean>();
const lastInteractiveChangeAt = new Map<number, number>();

// Transient click-through override, used while Spirit forwards a synthetic
// click/scroll to the app under the cursor (or while an LLM tool clicks).
// While an override is active the overlay is click-through even if
// interactiveState says interactive; when the override is released the
// stored interactive state is re-applied.
//
// REF-COUNTED: forwards can overlap (a click path holds the override while a
// scroll queued earlier is still in flight). A plain boolean toggle made the
// FIRST release win even though a second forward was still active, so the
// overlay went interactive mid-forward and the OS arrow flashed back. Each
// forward holds a +1; the overlay stays click-through until the count returns
// to 0.
const clickThroughRefCount = new Map<number, number>();

function applyInteractiveState(displayId: number): void {
  const win = overlayWindows.get(displayId);
  if (!win) return;
  if ((clickThroughRefCount.get(displayId) ?? 0) > 0) {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else if (interactiveState.get(displayId)) {
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
}

export function setOverlayInteractive(displayId: number, interactive: boolean): void {
  const win = overlayWindows.get(displayId);
  if (!win) return;
  if (interactiveState.get(displayId) === interactive) return;
  interactiveState.set(displayId, interactive);
  const now = Date.now();
  const prev = lastInteractiveChangeAt.get(displayId) ?? 0;
  const dtMs = prev > 0 ? now - prev : -1;
  lastInteractiveChangeAt.set(displayId, now);
  console.log(`[overlay] display=${displayId} interactive=${interactive} dt=${dtMs}ms`);
  // ONLY toggle setIgnoreMouseEvents. Earlier versions also called
  // setFocusable() and focus()/blur() on every transition — on macOS each
  // of those forces a full window-frame repaint, which the user saw as
  // the box "flickering" every time the cursor crossed the hover halo.
  // setFocusable(true) is now set once at construction (see below) and left
  // alone; DOM focus inside the box is handled by the input element itself.
  applyInteractiveState(displayId);
}

// Main-side read of the last renderer-driven interactive state. Used by the
// AI-mode end sweep: if the renderer never released capture (frozen/blank),
// main releases it.
export function isOverlayInteractive(displayId: number): boolean {
  return interactiveState.get(displayId) === true;
}

// Temporarily force the overlay click-through (forwarding:true keeps mouse
// moves flowing to the renderer so the custom cursor keeps tracking). The
// override is removed with overrideOverlayClickThrough(id, false) /
// overrideAllOverlaysClickThrough(false), which re-applies the stored state.
export function overrideOverlayClickThrough(displayId: number, override: boolean): void {
  const win = overlayWindows.get(displayId);
  if (!win) return;
  const cur = clickThroughRefCount.get(displayId) ?? 0;
  const next = Math.max(0, cur + (override ? 1 : -1));
  if (next === cur) return;
  clickThroughRefCount.set(displayId, next);
  applyInteractiveState(displayId);
}

export function overrideAllOverlaysClickThrough(override: boolean): void {
  for (const displayId of overlayWindows.keys()) {
    overrideOverlayClickThrough(displayId, override);
  }
}

// Lower or raise every overlay's alwaysOnTop level. Used to let the user
// Cmd+Tab to another app (e.g. Chrome to copy their API key) while the
// Settings panel is open — otherwise our screen-saver-level overlay sits
// in front of every other window and blocks the world.
//
// 3-level semantics:
//   on=true  → 'screen-saver' (above absolutely everything — overlay UX)
//   on=false → 'floating' (above regular app windows but NOT modal/
//              fullscreen; the Settings panel stays visible on top of
//              the user's browser etc, while still allowing Cmd+Tab to
//              focus a regular app underneath to copy text from it).
// Previously `false` dropped alwaysOnTop entirely, which made the
// Settings panel hide behind whatever app the user clicked into. User
// reported "Settings öffnen sich nicht on top sondern muss alles
// minimieren um sie zu sehen" — fixed by keeping floating-level on
// top.
export function setAllOverlaysAlwaysOnTop(on: boolean): void {
  for (const win of overlayWindows.values()) {
    if (win.isDestroyed()) continue;
    if (on) {
      win.setAlwaysOnTop(true, 'screen-saver');
      try { win.moveTop(); } catch { /* ignore */ }
    } else {
      // 'floating' sits above normal app windows but is still focusable
      // by other apps via Cmd+Tab. The Settings modal remains visible.
      win.setAlwaysOnTop(true, 'floating');
    }
  }
}

// Hide every overlay for the duration of fn(), then restore. Used to keep
// Spirit's own windows out of screenshots: desktopCapturer composites the
// screen as-is, and with alwaysOnTop='screen-saver' our overlays would show
// up in the capture (transparent windows still composite their contents,
// e.g. the hover halo or the prompt box). Hiding — not just lowering — the
// overlays guarantees the capture shows only the user's own content. The
// capture is fast, and the overlays return via showInactive() so no focus
// is stolen.
export async function withOverlaysHidden<T>(fn: () => Promise<T>): Promise<T> {
  const overlays = getAllOverlays();
  const visible = overlays.filter((w) => !w.isDestroyed() && w.isVisible());
  if (visible.length > 0) console.log(`[overlay] hiding ${visible.length} overlay(s) for capture`);
  for (const w of visible) w.hide();
  try {
    return await fn();
  } finally {
    for (const w of visible) {
      if (!w.isDestroyed()) w.showInactive();
    }
    if (visible.length > 0) console.log('[overlay] overlays restored after capture');
  }
}

export function destroyAllOverlays(): void {
  for (const win of overlayWindows.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  overlayWindows.clear();
}
