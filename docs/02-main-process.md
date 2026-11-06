# 02 — Main Process

`electron/main.ts` is the app bootstrap. It wires the global input hook, the
overlay windows, the tray, the IPC handlers, and the start/shutdown sequence.

## Entry points & guards

- `app.whenReady()` → `setup()` (guarded by `setupCalled` so macOS `activate`
  can't double-register IPC handlers or leak timers).
- `app.on('window-all-closed')` → quit (except macOS).
- `app.on('activate')` → `setup()` if no windows.
- `app.on('before-quit')` → `runBeforeQuitHandlers()` then tears down hook,
  cursor tracking, trigger detection, local STT, tray, about window, overlays.
- **Crash safety nets**: `process.on('unhandledRejection'/'uncaughtException')`
  log-and-keep-running; a fatal init error opens a native dialog offering to
  wipe the `userData` folder (settings/keys reset; workspace sessions kept).

## Startup sequence (`startMainApp`)

1. `createOverlayForAllDisplays()` — one transparent overlay per display.
2. `createTray()` — menu bar / tray icon.
3. `primeWindowsContextCache()` / `primePowerShellWorkers()` — warm the slow
   context readers so the first trigger doesn't pay cold-start latency.
4. `startLocalStt()` — best-effort local whisper sidecar (falls back to cloud
   STT if python/script missing; model loads lazily on first use).
5. macOS: `promptAccessibility()`; diagnose Screen Recording, auto-open
   System Settings once if missing.
6. `tryStartHook()` — start the global hook; if accessibility is not granted,
   poll every 2s until it succeeds.
7. On display add/remove: destroy + recreate all overlays.

## Global hook wiring (`tryStartHook`)

`startTriggerDetection` receives callbacks that drive the whole app:

- **`onStart`** (trigger pressed): read cursor point, snapshot clipboard,
  kick off `snapshotSelection()` + `snapshotAppContext()` (async, self-skipping),
  then `broadcastAIModeStart()` and `broadcastClipboardContext()`. Starts the
  clipboard poll + app-context tracking. The screenshot is **lazy**
  (`scheduleLazyScreenshot`, +400ms) and fire-and-forget so the pill's entrance
  animation is never stuttered; chips are scheduled the same way.
- **`onEnd`**: stop tracking/polling. ESC genuinely cancels the stream; other
  dismissal paths keep the stream alive in the background. Clears all pending
  captures and extends the session window (`extendSessionWindow`) so a quick
  re-trigger stays in the same session, then `broadcastAIModeEnd(reason)`.
- **`onSelectionArm`**: forward arm state (drag-to-screenshot mode) to the
  renderer.
- **`onExternalTyping`**: forward raw "user is typing/clicking elsewhere"
  signals; the renderer decides what to do (see `14-renderer.md`).

`startCursorTracking()` runs unconditionally so the renderer can hit-test
interactive zones and toggle `setIgnoreMouseEvents`.

## Timer management

- `hookRetryTimer` — accessibility poll.
- `clipboardPollTimer` — 400ms clipboard poll while a box is open.
- `lazyScreenshotTimer` / `chipsTimer` — 400ms lazy kickoffs after box open.

All are cleared on quit; the lazy screenshot/chips are also cleared in `onEnd`.

## Why these details matter (pitfalls documented in code)

- The first-trigger "box appears and disappears" bug was caused by a cold
  PowerShell context worker gating the broadcast; the fix is to broadcast
  immediately and let context chips populate asynchronously.
- Screenshot/chips must not run at t=0 of the box entrance — they briefly hide
  overlays and stutter the pop, so they're delayed 400ms.
- `setupCalled` guard prevents double registration when macOS fires `activate`
  after `ready`.
