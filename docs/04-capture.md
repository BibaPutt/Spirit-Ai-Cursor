# 04 — Capture (`electron/capture/*`)

Everything that reads "what is on / around the user's screen". All capture
work is main-process; the renderer only receives the results via IPC.

## Module-by-module

### `screenshot.ts`
- `getCropDimensions()` — crop window size for cursor-centered captures.
- `captureAroundCursor(cursor)` — full-display capture cropped around the
  cursor; returns a data URL (used by the screenshot chip + query context).
- `captureRectFromDisplay` — capture an arbitrary rect on a display (drag
  screenshot).
- `captureScreenRegionB64` — region → base64 PNG.
- `canCaptureScreen()` — macOS screen-recording permission probe (used at
  startup to auto-open System Settings).
- `captureActiveWindowForAgent()` — used by the `see_screen` tool to feed the
  model the current window.

### `ocr.ts`
- `ocrRegionText` — OCR a display region via Tesseract.
- `ocrImageB64Text(b64)` — OCR an in-memory image (used by paint-to-select
  bubbles and clipboard images).

### `scene.ts`
The **scene graph** — a structured read of the screen used by agent tools
(`ui_read`, `ui_click`, `see_screen`).
- `Scene` / `SceneElement` interfaces; `buildScene()` assembles the UI tree
  (windows + controls) with bounding boxes and role.
- `formatScene()` — render the scene to text for the model.
- `buildClickTargetsMenu(scene, limit, goal)` — rank clickable targets,
  optionally scored against a goal (`goalTokens`/`goalScoreFor` token
  scoring) so the model is offered the most relevant targets.
- `resolveElementById()` — map a model-chosen element id back to a rect for
  `ui_click`.

### `selection.ts`
- `captureSelectedText()` — read the current on-screen text selection
  (accessibility selection read on macOS, UIA on Windows). Returns plain text
  for the "selected text" chip / query context.

### `clipboard.ts`
- `readClipboardText()` — current clipboard text (no polling; polling lives in
  `main.ts`'s `startClipboardPoll`, which calls this and broadcasts).

### `app-context.ts`
- `AppContext` — identity of the foreground app (name, bundle id, window
  title, active tab, etc.).
- `captureForegroundApp(opts)` — one-shot read of the foreground app.
- `primeWindowsContextCache()` — pre-warm the Windows CDP owner cache at
  launch so the first read is fast.
- `isSelfContext()` — true when the context is Spirit's own window (guard
  against reading ourselves).
- `resolveAgentTargetHwnd()` — the window the agent's tools should target
  (skips Spirit's own overlay windows).
- `tabTitleFromWindow` — extract a browser tab title from a window title.
- `appContextTextFrom` / `previewFromAppContext` — render context for the
  prompt / UI chip.

### `active-tab.ts`
- `reconcileActiveTab(ctx)` — reconcile the browser-tab model with a fresh
  app-context read; `isHostLikeLabel()` filters app-like labels.

### `foreground-watcher.ts`
- `startAppContextWatcher(cb)` / `stopAppContextWatcher()` — a self-skipping
  1s poll that tracks the foreground app while a box is open (so switching apps
  mid-session updates the chip + submit context).

### `spirit-windows.ts`
- `isSpiritWindowHandle(hwnd)` / `getSpiritWindowHandles()` — identify Spirit's
  own overlay windows by handle so captures can exclude them (prevents
  screenshotting our own overlay).

### `ps-worker.ts`
A persistent, warmed PowerShell worker pool (Windows) to avoid cold `spawn`
latency for context reads.
- `runPowerShell(script)` / `runSelectionPowerShell` / `runCursorPowerShell`
  (cursor variant has a shorter 4s timeout).
- `primePowerShellWorkers()` — warm both workers at launch.
- `disposePowerShellWorker()` — teardown at quit.

## Cross-cutting: self-exclusion

Captures exclude Spirit's own overlay windows (`spirit-windows.ts`) so the
pill/screenshot chip never appear in the AI's context. The screenshot is taken
**lazily after the box appears** (400ms) and the overlays are hidden during
capture — see `02-main-process.md`.

## Data shapes that flow out

- Screenshot → data URL / base64 → query context or chips.
- Clipboard / selection / app-context → text chips + appended to the prompt
  as `screenContext`.
- Scene → text block handed to tools; element ids resolve to rects for clicks.
