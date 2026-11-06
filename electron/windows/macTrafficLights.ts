import type { BrowserWindow } from 'electron';

// Aggressively hide the macOS traffic-light buttons (red close / yellow
// minimize / green zoom) on a BrowserWindow.
//
// Why this needs to be aggressive: `win.setWindowButtonVisibility(false)`
// is the canonical Electron API, but on macOS the AppKit window machinery
// re-creates the button cells on a number of state transitions —
// ready-to-show, focus changes, becoming key/main, leaving fullscreen,
// even after DevTools opens against the window. Calling the API once at
// creation works on a freshly-created window but the buttons can
// re-appear later. Worse, on a `type: 'panel'` (NSPanel) overlay with
// `transparent: true`, AppKit briefly paints the trafficlights for one
// or two frames during ready-to-show, which is exactly what the user
// reported seeing at top-left.
//
// The robust fix is to subscribe to every event where buttons might
// reappear and re-call the API. We also move the traffic-light position
// off-screen via `trafficLightPosition: { x: -100, y: -100 }` (only
// valid when titleBarStyle is hidden/hiddenInset) so even if AppKit
// momentarily renders them, they're drawn at coordinates the user can't
// see. Two layers of defense.
//
// Each call is wrapped in try/catch because:
//   - setWindowButtonVisibility throws if titleBarStyle is the default,
//     and we sometimes call this from a generic helper that doesn't
//     know the caller's titleBarStyle.
//   - The window may be destroyed by the time a deferred listener fires.

export function hideMacTrafficLights(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return;

  const apply = (): void => {
    if (win.isDestroyed()) return;
    try {
      win.setWindowButtonVisibility(false);
    } catch {
      /* titleBarStyle doesn't support it, or window is destroyed */
    }
    try {
      // Park the buttons off-screen as a fallback. Only takes effect when
      // titleBarStyle is 'hidden' / 'hiddenInset'; harmless otherwise.
      win.setWindowButtonPosition({ x: -1000, y: -1000 });
    } catch {
      /* setWindowButtonPosition exists only with hidden titlebars */
    }
  };

  // Initial pass — covers windows that are already visible by the time
  // the helper is called.
  apply();

  // Every event where AppKit might re-create the button cells:
  win.once('ready-to-show', apply);
  win.on('show', apply);
  win.on('focus', apply);
  win.on('blur', apply);
  win.on('restore', apply);
  win.on('enter-full-screen', apply);
  win.on('leave-full-screen', apply);
  // DevTools attach/detach also nudges AppKit on macOS.
  win.webContents.on('devtools-opened', apply);
  win.webContents.on('devtools-closed', apply);
  // One last belt-and-braces pass a few hundred ms after creation, for
  // the rare race where the window appears slightly before any of the
  // above events fire (seen on macOS 14 with `type: 'panel'`).
  setTimeout(apply, 120);
  setTimeout(apply, 400);
}
