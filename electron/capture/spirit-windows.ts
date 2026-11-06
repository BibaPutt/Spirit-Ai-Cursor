// Registry of native window handles for every Spirit BrowserWindow (all
// overlays + About). Belt-and-suspenders self-capture detection: when the
// OS foreground-window read comes back with one of these handles, the app
// context belongs to Spirit itself (the box holds focus while it's open),
// not to the app the user is actually working in, so it must be skipped.
//
// The primary self-check is pid === process.pid (every Spirit window shares
// the Electron main-process pid on every OS); the hwnd comparison only
// matters on Windows, where user32 GetForegroundWindow returns a real HWND
// that we can compare against getNativeWindowHandle(). macOS/Linux handles
// are opaque pointers we can't compare, so they're skipped here.

import { BrowserWindow } from 'electron';
import { getAllOverlays } from '../windows/overlay';
import { getAboutWindow } from '../windows/about';

const spiritHandles = new Set<string>();

// Re-read native handles from every live Spirit window. Cheap (a handful of
// windows), so it runs on each lookup and never needs to be manually wired
// to window lifecycle events.
function refresh(): void {
  spiritHandles.clear();
  if (process.platform !== 'win32') return;

  const wins = [...getAllOverlays()];
  const about = getAboutWindow();
  if (about) wins.push(about);

  for (const win of wins) {
    if (win.isDestroyed()) continue;
    try {
      const buf = win.getNativeWindowHandle();
      // HWND is the native pointer value: 8 bytes on 64-bit Windows.
      if (buf && buf.length >= 8) {
        spiritHandles.add(buf.readBigInt64LE(0).toString());
      }
    } catch {
      /* window may have closed between listing and reading */
    }
  }
}

export function isSpiritWindowHandle(hwnd: string | null | undefined): boolean {
  if (!hwnd) return false;
  refresh();
  return spiritHandles.has(hwnd);
}

// Decimal HWND strings for every live Spirit window. The cursor-shape probe
// (WM_SETCURSOR) walks the z-order past these so it asks the app BENEATH the
// full-screen transparent overlays which cursor it would show.
export function getSpiritWindowHandles(): string[] {
  refresh();
  return [...spiritHandles];
}
