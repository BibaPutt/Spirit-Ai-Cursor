// Foreground-app tracker that runs ONLY while the AI-mode box is open
// (started from onStart, stopped from onEnd). It reports real, non-Spirit
// apps to the listener — so the app-context chip and the submit path always
// reflect the app the user is ACTUALLY working in, even after they switch
// apps or tabs while the box is open.
//
// EVENT-DRIVEN, NO POLLING. While the box is open Spirit holds focus, so a
// naive foreground poll reports "Spirit" most of the time — the old 2s
// setInterval only ever saw the overlay, silently dropped every sample, and
// the context froze at whatever app was captured at trigger time. Instead we
// react to the inputs that actually change the context:
//   - mousedown: the user clicked somewhere. The click raises the target
//     window just below our full-screen always-on-top overlay, so the
//     Z-order walk (captureTopmostAppContext / contextAtPoint) finds it; the
//     context is then enriched by HWND so the tab/URL follows.
//   - keydown: tab-switch shortcuts (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp/
//     PageDown, macOS Cmd+Alt+Left/Right) re-read the topmost browser and
//     refresh its tab/URL by handle.
// A short trailing-edge coalesce (~700ms) makes a fast burst (Ctrl+Tab three
// times, or several quick clicks) settle on the LAST window/tab, and an
// emit-key dedupe stops the chip from re-broadcasting an unchanged context.
//
// Self-exclusion is central: we drop any read that is Spirit itself (pid
// our pid, or our own HWND) and only ever surface the user's real foreground
// app. Failed reads are dropped silently — the chip keeps its last good value
// instead of flickering to nothing.
//
// Performance: the identity/topmost read is ~50ms in the persistent
// PowerShell worker; the expensive ~1s UIA URL walk runs only when the
// context actually merits it (window changed, or enough time passed since the
// last same-window walk so a click in the browser's tab strip is still
// caught).

import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi';
import type { AppContext } from '../types';
import {
  captureTopmostAppContext,
  contextAtPoint,
  enrichContextByHandle,
  isSelfContext,
  setExternalForeground,
} from './app-context';

// How long after the last qualifying input event to wait before emitting, so
// a rapid burst settles on the final window/tab.
const COALESCE_MS = 700;
// Minimum gap between same-window URL walks: a click on a browser's tab strip
// changes the tab even though the window stays the same, but clicks on page
// content must not hammer the ~1s UIA walk.
const ENRICH_MIN_MS = 800;
// Delay before re-reading after a keyboard tab switch, so the browser has
// actually switched tabs by the time we read its URL (the hook fires before
// the target app processes the key).
const TAB_KEY_READ_DELAY_MS = 180;

let running = false;
let listener: ((ctx: AppContext) => void) | null = null;
let lastEmitKey: string | null = null;
let lastWindowKey: string | null = null;
let lastEnrichAt = 0;
let coalesceTimer: NodeJS.Timeout | null = null;
let pendingCtx: AppContext | null = null;

function ctxKey(ctx: AppContext): string {
  return `${ctx.pid}|${ctx.hwnd ?? ''}|${ctx.url ?? ''}|${ctx.activeTab ?? ''}|${ctx.title}`;
}

// Only surface ENRICHED contexts (with tab/URL). Surfacing the bare identity
// read would overwrite the enriched value with just the app name, so the chip
// (and lastAppContext) would flicker between "Arc" and the real tab.
function scheduleEmit(ctx: AppContext): void {
  if (!running || !ctx || isSelfContext(ctx)) return;
  pendingCtx = ctx;
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    if (!running || !pendingCtx) return;
    const c = pendingCtx;
    pendingCtx = null;
    const key = ctxKey(c);
    if (key === lastEmitKey) return;
    lastEmitKey = key;
    // The clicked/active window is now the agent's action target — even when
    // it differs from the previous one, because the user just switched to it
    // (this is a real switch, not a stale background walk).
    setExternalForeground(c);
    listener?.(c);
  }, COALESCE_MS);
}

async function onMouseDown(e: UiohookMouseEvent): Promise<void> {
  if (!running) return;
  let ctx: AppContext | null = null;
  try {
    ctx = await contextAtPoint(e.x, e.y);
  } catch {
    return;
  }
  if (!ctx || isSelfContext(ctx)) return;
  const winKey = `${ctx.pid}|${ctx.hwnd ?? ''}`;
  const windowChanged = winKey !== lastWindowKey;
  lastWindowKey = winKey;
  const now = Date.now();
  // A window change always warrants a fresh URL/tab walk (the user switched
  // apps). Same-window clicks only walk after enough time has passed — that
  // still catches a click on the browser's tab strip (which changes the tab
  // without changing the window) while keeping plain page clicks cheap.
  if (!windowChanged && now - lastEnrichAt < ENRICH_MIN_MS) return;
  lastEnrichAt = now;
  await enrichContextByHandle(ctx);
  if (running) scheduleEmit(ctx);
}

function isTabSwitchShortcut(e: UiohookKeyboardEvent): boolean {
  const k = e.keycode;
  // Windows/Linux: Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp/PageDown.
  if (k === UiohookKey.Tab && e.ctrlKey) return true;
  if ((k === UiohookKey.PageUp || k === UiohookKey.PageDown) && e.ctrlKey) return true;
  // macOS: Cmd+Alt+Left/Right.
  if ((k === UiohookKey.ArrowLeft || k === UiohookKey.ArrowRight) && e.metaKey && e.altKey) {
    return true;
  }
  return false;
}

function onKeyDown(e: UiohookKeyboardEvent): void {
  if (!running) return;
  if (!isTabSwitchShortcut(e)) return;
  // The keydown fires BEFORE the browser processes the switch, so wait a beat
  // before re-reading; the trailing-edge coalesce then settles a burst of
  // switches on the final tab.
  setTimeout(() => {
    if (!running) return;
    void (async () => {
      let ctx: AppContext | null = null;
      try {
        ctx = await captureTopmostAppContext();
      } catch {
        return;
      }
      if (!ctx || isSelfContext(ctx)) return;
      lastWindowKey = `${ctx.pid}|${ctx.hwnd ?? ''}`;
      lastEnrichAt = Date.now();
      await enrichContextByHandle(ctx);
      if (running) scheduleEmit(ctx);
    })();
  }, TAB_KEY_READ_DELAY_MS);
}

export function startAppContextWatcher(cb: (ctx: AppContext) => void): void {
  listener = cb;
  if (running) return;
  running = true;
  lastEmitKey = null;
  lastWindowKey = null;
  lastEnrichAt = 0;
  uIOhook.on('mousedown', onMouseDown);
  uIOhook.on('keydown', onKeyDown);
  // Prime immediately: one topmost read on start so a submit within the first
  // moment still sees a fresh context instead of the previous session's value.
  void (async () => {
    let ctx: AppContext | null = null;
    try {
      ctx = await captureTopmostAppContext();
    } catch {
      return;
    }
    if (!ctx || isSelfContext(ctx)) return;
    lastWindowKey = `${ctx.pid}|${ctx.hwnd ?? ''}`;
    lastEnrichAt = Date.now();
    await enrichContextByHandle(ctx);
    if (running) scheduleEmit(ctx);
  })();
}

export function stopAppContextWatcher(): void {
  running = false;
  if (coalesceTimer) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  pendingCtx = null;
  uIOhook.off('mousedown', onMouseDown);
  uIOhook.off('keydown', onKeyDown);
  listener = null;
}

export function isAppContextWatcherRunning(): boolean {
  return running;
}
