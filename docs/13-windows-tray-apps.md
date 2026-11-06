# 13 — Windows, Tray, Apps, System, Permissions, Autostart, Lifecycle

Supporting main-process modules that don't fit capture/input/llm/memory/store.

## `windows/` — BrowserWindows

### `overlay.ts`
The transparent, frameless, always-on-top overlay windows — one per display,
loading the Vite-rendered `renderer` app with `?displayId=N&primary=1`.
- `createOverlayForDisplay(display)` / `createOverlayForAllDisplays()` /
  `destroyAllOverlays()` — the full overlay set is rebuilt on display add/remove.
- `getOverlayForDisplay(id)` / `getAllOverlays()` / `getOverlayEntries()` —
  lookup helpers.
- `setOverlayInteractive(displayId, on)` — toggle `setIgnoreMouseEvents`
  (click-through) so the pill is interactive when the cursor is over it.
- `overrideOverlayClickThrough` / `overrideAllOverlaysClickThrough` —
  temporary click-through overrides (used around screenshots / Settings).
- `setAllOverlaysAlwaysOnTop(on)` — lower always-on-top while Settings is
  open so Cmd+Tab to a browser works.
- `withOverlaysHidden(fn)` — hide overlays, run `fn` (e.g. capture the real
  screen), restore. Used by screenshots so the pill never appears in its own
  capture.

### `about.ts`
- `showAboutWindow()` / `getAboutWindow()` / `destroyAboutWindow()` — the
  About panel window (opened from the tray menu).

### `macTrafficLights.ts`
- `hideMacTrafficLights(win)` — hide the macOS traffic lights on the frameless
  overlays.

## `tray/` — menu bar / system tray

### `tray.ts`
- `createTray()` — builds the tray icon + menu (open settings, show about,
  trigger AI mode, quit).
- `rebuildMenu()` — refresh the menu when settings change (e.g. enabled
  providers).
- `destroyTray()`.

### `icon.ts`
- `getTrayIcon()` — `NativeImage` for the tray.
- `getAppIconPath()` — renders/generates the placeholder app icon PNG used by
  the About panel (`main.ts` calls this at startup).

## `apps/launcher.ts` — launchable-app registry
- `AppEntry` / `getAppRegistry()` / `getValidAppIds()` — the known apps the
  `launch_app` tool can open (browsers, editors, terminals…).
- `listLaunchableApps()` — for the Settings "apps" picker + `apps:list` IPC.
- `launchApp(appId)` — launch via AppleScript (macOS) / PowerShell (Windows).
- `focusLaunchedApp(appId)` — bring a launched app to the foreground.

## `system/audio.ts`
- `setSystemVolume(args)` — set the OS volume, used by the `set_volume` tool
  (AppleScript on macOS, PowerShell `Set-AudioDevice`-style on Windows).

## `permissions.ts` (main root)
- macOS permissions: `promptAccessibility()`, `getPermissionsSync()`,
  `getPermissions()` (IPC), `openSystemSettings(kind)` (opens the right System
  Settings pane). Screen-recording is diagnosed via `capture/canCaptureScreen()`.

## `autostart.ts` (main root)
- `autostart:get` / `autostart:set` IPC — register/unregister the app to
  launch at login (via Electron `app.setLoginItemSettings`).

## `lifecycle.ts` (main root)
- `runBeforeQuitHandlers()` — the registry of teardown tasks executed in
  `main.ts`'s `before-quit` (stop hooks, dispose workers, close windows).

See also [02-main-process.md](02-main-process.md) for how these are wired at
startup, and [14-renderer.md](14-renderer.md) for the overlay UI itself.
