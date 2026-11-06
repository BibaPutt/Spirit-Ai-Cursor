# 05 — Input (`electron/input/*`)

The main process owns all global input: it listens to the OS-level keyboard
and mouse (via uiohook-napi) and forwards "events" both to the renderer (to
drive the overlay) and to the OS (to click/type on the user's behalf).

## Module-by-module

### `global-hook.ts`
- `startGlobalHook()` / `stopGlobalHook()` / `isGlobalHookStarted()` — wraps
  the native uiohook keyboard/mouse listener. Started only once accessibility
  permission is granted (`tryStartHook` in main.ts retries every 2s).

### `trigger.ts`
The heart of the "AI mode" gesture.
- `startTriggerDetection(listeners)` — wires raw hook events into a state
  machine that detects the trigger key (Right-Cmd) hold, selection-arm,
  outside-box clicks, ESC, and external typing.
- `State` tracks AI-mode on/off. Listeners:
  - `onStart(cursor)` — trigger held: capture context, broadcast AIModeStart.
  - `onEnd(reason)` — trigger released / dismissed: broadcast AIModeEnd.
  - `onSelectionArm(armed)` — trigger held while box open → drag-to-screenshot
    mode.
  - `onExternalTyping({kind})` — user typed/clicked outside the box; forwarded
    raw to the renderer, which decides dismissal (see 14-renderer).
- `setActiveBoxBounds(bounds)` — the renderer reports the pill's bounds so the
  hook can distinguish "clicked outside the box" from "clicked in the box".
- `setCaptureMode(displayId, on)` / `isCaptureModeActive()` — while a display
  is in capture mode, the hook skips its own outside-click dismissal and
  ignores synthetic events from click/scroll forwarding (the DOM overlay owns
  dismissal instead).
- `endAIMode(reason)` / `startAIModeManually()` / `getAIModeState()` — manual
  control used by tray menu, `/settings`, and the IPC cancel path.

### `cursor.ts`
- `startCursorTracking()` / `stopCursorTracking()` / `isCursorTrackingActive()`
  — polls the global cursor position and broadcasts `cursor:position` so every
  overlay knows where to anchor / hit-test.

### `cursor-shape.ts`
- `startCursorShapeProbing()` / `stopCursorShapeProbing()` — reads the OS
  cursor shape (arrow, I-beam, hand…) so the custom branded cursor can morph
  (`CursorPosition.shape`). Windows uses a polling probe; macOS may use a
  different mechanism.

### `focus.ts`
- `captureForeground()` — capture the current foreground window handle.
- `restoreForeground(hwnd)` — give focus back to a previously captured window
  (used after overlays steal focus, e.g. around text insertion).

### `actions.ts`
The low-level input executor used by **both** the tools layer and click/scroll
forwarding. Pure OS actions, all implemented cross-platform (PowerShell on
Windows, AppleScript on macOS, etc.):
- `pressKey(combo, times)` — send key combinations; `parseKeyCombo()` parses
  `"Cmd+Shift+F"` style strings.
- `typeText(text)` — type into the focused app.
- `moveMouse(x, y)` / `clickAt(...)` / `drag(...)` / `scrollLines(delta)`.
- `forwardClickAt(x, y, button)` / `forwardScroll(delta)` — replay a click or
  scroll onto the app underneath the cursor (called when capture mode swallows
  the user's own gesture).
- `releaseOverlayFocus()` / `focusProcessWindows(names)` — focus helpers for
  tools that open apps (Notepad, browser…).
