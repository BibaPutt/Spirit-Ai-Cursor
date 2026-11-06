import './dev/session-log';
import { app, BrowserWindow, dialog, globalShortcut, powerMonitor, screen } from 'electron';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import {
  createOverlayForAllDisplays,
  destroyAllOverlays,
  restoreOverlaysAfterWake,
  setContentProtectionEnabled,
  setOverlaysSkipTaskbar,
} from './windows/overlay';
import { startGlobalHook, stopGlobalHook, isGlobalHookStarted } from './input/global-hook';
import { killStaleDriverProcesses } from './input/cua-driver-client';
import { startTriggerDetection, stopTriggerDetection } from './input/trigger';
import { setForwardedClickEatenHandler } from './input/forward-tracker';
import { stopCursorTracking, isCursorTrackingActive } from './input/cursor';
import {
  registerIpcHandlers,
  broadcastAIModeStart,
  broadcastAIModeEnd,
  broadcastSelectionArm,
  broadcastExternalTyping,
  broadcastForwardedClickEaten,
  runLaunchCapture,
  clearPendingScreenshot,
  cancelCurrentStream,
  snapshotClipboard,
  clearPendingClipboard,
  broadcastClipboardContext,
  extendSessionWindow,
  pollClipboardIfChanged,
  snapshotSelection,
  clearPendingSelection,
  clearPendingPaintSelections,
  snapshotAppContext,
  clearPendingAppContext,
  startAppContextTracking,
  stopAppContextTracking,
  clearPendingChips,
  noteTriggerOpened,
} from './ipc/handlers';
import { getPermissionsSync, promptAccessibility, openSystemSettings } from './permissions';
import { canCaptureScreen } from './capture/screenshot';
import { createTray, destroyTray } from './tray/tray';
import { getAppIconPath } from './tray/icon';
import { destroyAboutWindow } from './windows/about';
import { destroyLegalWindow } from './windows/legal';
import {
  getGhostHideTaskbar,
  getGhostMode,
  getSettings,
  runProviderHealthProbe,
  setSettings,
} from './store/settings';
import { stopLocalStt, isLocalSttAvailable, getSttStatus } from './voice/local-stt';
import { runBeforeQuitHandlers } from './lifecycle';
import { primeWindowsContextCache } from './capture/app-context';
import {
  primePowerShellWorkers,
  schedulePowerShellIdleUnload,
  cancelPowerShellIdleUnload,
  isPowerShellWorkerRunning,
  disposePowerShellWorker,
} from './capture/ps-worker';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  // quit() is asynchronous — without a hard stop the losing instance keeps
  // running every line below (hooks, tray, windows, timers) against a
  // process that is already tearing down, which is the double-instance
  // crash. Exit before any startup work registers.
  process.exit(0);
}

// Catch-all so a stray rejection or thrown error in main does not silently
// terminate the process and leave the user staring at a frozen overlay. We
// log and keep running; the affected feature surfaces its own error via the
// router / IPC error channel.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

app.setName('Spirit');

// TTS/Read-aloud playback happens AFTER an await of the synthesize IPC
// (1-3s of network + audio generation). By then the click's user-activation
// has expired, so Chromium's default `document-user-activation-required`
// autoplay policy rejects audio.play() with NotAllowedError and the Read
// button silently produces no sound. Lift the gesture requirement so the
// returned MP3 always plays.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// About panel is set with placeholder values now; the iconPath gets filled
// in once getAppIconPath() has rendered the placeholder PNG.
const ABOUT_BASE: Electron.AboutPanelOptionsOptions = {
  applicationName: 'Spirit',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: 'No telemetry, no analytics, no cloud.',
};
app.setAboutPanelOptions(ABOUT_BASE);
void getAppIconPath()
  .then((iconPath) => app.setAboutPanelOptions({ ...ABOUT_BASE, iconPath }))
  .catch((err) => console.warn('[main] could not set About icon', err));

if (process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

let hookRetryTimer: NodeJS.Timeout | null = null;
let clipboardPollTimer: NodeJS.Timeout | null = null;
let launchCaptureTimer: NodeJS.Timeout | null = null;

// Fire-and-forget lazy box-open work, scheduled AFTER the prompt box has
// appeared and its entrance animation has settled. Captures the trigger
// screenshot for the preview chip and feeds ONE region OCR for the suggestion
// chips. On Windows both captures run in the persistent GDI worker (native
// path) so the main thread — which drives the 33ms cursor heartbeat — is never
// blocked by desktopCapturer's full-res captures. The AI-bound screen text is
// NOT read here — it's OCR'd fresh at submit time, so the model always sees the
// current screen. Previously two independent +400ms timers each took their own
// full-screen desktopCapturer read plus two OCR runs, which blocked the main
// thread (and the 33ms cursor heartbeat) and pegged CPU cores for the first
// seconds after opening.
function scheduleLaunchCapture(cursor: { x: number; y: number }): void {
  if (launchCaptureTimer) clearTimeout(launchCaptureTimer);
  launchCaptureTimer = setTimeout(() => {
    launchCaptureTimer = null;
    void runLaunchCapture(cursor);
  }, 400);
}

// Adaptive clipboard poll: fast (400ms) right after a change, slows to 2 s
// after 10 s of no changes. A Cmd+C during the session still feels instant
// (snaps back to 400ms on first change), but a quiet clipboard stops burning
// 2.5 wakeups/s.
const CLIPBOARD_FAST_MS = 400;
const CLIPBOARD_SLOW_MS = 2000;
const CLIPBOARD_BACKOFF_MS = 10_000;
let clipboardLastChangeAt = 0;

function clipboardLoop(): void {
  clipboardPollTimer = null;
  const change = pollClipboardIfChanged();
  if (change) {
    broadcastClipboardContext(change);
    clipboardLastChangeAt = Date.now();
  }
  const idle = Date.now() - clipboardLastChangeAt;
  const delay = idle < CLIPBOARD_BACKOFF_MS ? CLIPBOARD_FAST_MS : CLIPBOARD_SLOW_MS;
  clipboardPollTimer = setTimeout(clipboardLoop, delay);
}

function startClipboardPoll(): void {
  if (clipboardPollTimer) return;
  clipboardLastChangeAt = Date.now();
  clipboardLoop();
}

function stopClipboardPoll(): void {
  if (clipboardPollTimer) {
    clearTimeout(clipboardPollTimer);
    clipboardPollTimer = null;
  }
}

function tryStartHook(): boolean {
  if (isGlobalHookStarted()) return true;
  const perms = getPermissionsSync();
  if (!perms.accessibility) return false;
  if (!startGlobalHook()) return false;
  startTriggerDetection({
    onStart: () => {
      console.log('[main] AI mode started');
      // Re-warm the PowerShell workers if an idle stretch unloaded them — the
      // cold ~1.5s start gets hidden behind the box-open instead of costing a
      // stall on the first screenshot/read. This also cancels the idle-unload
      // timer so workers stay warm for the session.
      cancelPowerShellIdleUnload();
      primePowerShellWorkers();
      // Capture screenshot BEFORE renderer paints prompt input, so the prompt UI
      // doesn't end up in its own screenshot. Halo + prompt arrive a beat later.
      const cursor = screen.getCursorScreenPoint();
      const clipSnap = snapshotClipboard();
      // A fresh trigger means the next submit is a NEW task by default
      // (unless the typed prompt is a short continuation fragment) — this
      // keeps a stale goal like a "Suggest a reply" draft from leaking into a
      // question the user asks on another screen.
      noteTriggerOpened();
      // Capture the user's on-screen text selection. Async — the box opens
      // immediately and the selected-text chip pops in when the read lands
      // (UIA on Windows, or the accessibility selection read on macOS).
      void snapshotSelection(cursor);
      // Kick off the app-context identity read BEFORE broadcastAIModeStart
      // focuses the overlay, so GetForegroundWindow can still read the app the
      // user was in. The broadcast must NOT wait on it — the box has to open
      // instantly. Holding the box open behind this promise was the source of
      // the "first trigger appears and disappears" bug: on the FIRST trigger
      // the context PowerShell worker was still cold (only the selection
      // worker was primed at launch), so the ~1.5s powershell.exe spawn gated
      // the box while the trigger was already 'active' — the user re-gestured
      // during the wait, which armed selection mode, and the box then opened
      // collapsed ("disappeared"). Subsequent triggers worked because the
      // worker was warm. Now the broadcast is immediate; the chip populates
      // whenever the read lands (self-skip in snapshotAppContext guards the
      // Spirit-focus race), and primePowerShellWorkers warms the worker at
      // launch so the read itself is ~50ms.
      void snapshotAppContext(cursor);
      broadcastAIModeStart();
      broadcastClipboardContext(clipSnap);
      // Begin polling the clipboard so a Cmd+C while the box is open
      // updates the preview chip live, without the user having to
      // re-trigger.
      startClipboardPoll();
      // Track the foreground app WHILE the box is open (self-skipping 1s
      // poll). The overlay holds focus for the whole session, so this is
      // the only way the chip + submit can follow the user switching apps
      // or tabs mid-session. Switching tabs always means focusing the
      // browser, so a foreground poll reads the current tab.
      startAppContextTracking();
      // Single lazy capture at +400ms: one full-display desktopCapturer read
      // feeds both the screenshot chip AND the suggestion-chip OCR, so the
      // main thread isn't blocked by two racing full-screen captures while it
      // should be keeping the custom cursor heartbeat steady. Suggestion chips
      // are TEXT-ONLY.
      scheduleLaunchCapture(cursor);
    },
    onEnd: (reason?: string) => {
      console.log(`[main] AI mode ended, reason=${reason ?? 'unknown'}`);
      stopAppContextTracking();
      stopClipboardPoll();
      // ESC is an explicit "stop it" gesture: genuinely cancel the in-flight
      // answer. Every other dismissal path (backdrop, idle, busy-elsewhere)
      // must NOT cancel the stream — an in-flight answer keeps streaming in
      // the background after the box is hidden, so the next trigger shows the
      // completed result instead of a truncated one.
      if (reason === 'escape') cancelCurrentStream();
      if (launchCaptureTimer) {
        clearTimeout(launchCaptureTimer);
        launchCaptureTimer = null;
      }
      clearPendingScreenshot();
      clearPendingClipboard();
      clearPendingSelection();
      clearPendingPaintSelections();
      clearPendingAppContext();
      clearPendingChips();
      // Keep the conversation alive for the 120s rolling window instead of
      // killing it here: the box just closed, but the user may re-trigger a
      // moment later with a follow-up answer ("windows") that must land in the
      // same session. extendSessionWindow schedules the real end after the TTL.
      void extendSessionWindow();
      // No more reads expected until the next trigger — arm the adaptive idle
      // unload so the PowerShell workers don't sit in memory forever.
      schedulePowerShellIdleUnload();
      broadcastAIModeEnd(reason);
    },
    onSelectionArm: (armed: boolean) => {
      broadcastSelectionArm(armed);
    },
    onExternalTyping: (kind) => {
      broadcastExternalTyping(kind);
    },
  });
  setForwardedClickEatenHandler((count) => {
    broadcastForwardedClickEaten(count);
  });

  console.log('[main] global hook started, trigger detection attached');
  return true;
}

// Resource debug logger — emits a one-liner every 5 s while the app is alive.
// Enable with SPIRIT_DEBUG_RESOURCE=1 in the environment. When enabled the
// log line shows:
//   - main-process heap / RSS / external
//   - renderer memory + CPU (via app.getAppMetrics())
//   - overall CPU usage delta since last tick (% of one core)
//   - which Spirit subsystems are active
let _prevCpuUsage = process.cpuUsage();

// Flip to true (and uncomment the console.log below) to re-enable the periodic
// resource probe. Left false because the log line is currently disabled — the
// interval used to run every 5 s doing app.getAppMetrics() + memoryUsage() +
// cpuUsage() with the result thrown away, which is measurable main-process
// waste on a low-end box. The env-var gate below still starts the interval;
// this const makes the interval body a near-zero-cost no-op while the log is
// off.
const RESOURCE_DEBUG_LOG_ENABLED = false;

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function startResourceDebugLogger(): void {
  const interval = setInterval(() => {
    if (!RESOURCE_DEBUG_LOG_ENABLED) return;
    const now = Date.now();

    // ── Main process memory ──────────────────────────────────────────────
    const mainMem = process.memoryUsage();

    // ── CPU delta (user + sys) since last tick → % of one core ───────────
    const cpuNow = process.cpuUsage();
    const deltaUser = cpuNow.user - _prevCpuUsage.user;   // µs
    const deltaSys  = cpuNow.system - _prevCpuUsage.system;
    _prevCpuUsage = cpuNow;
    // interval is 5 000 ms = 5 000 000 µs → % of one core = delta / 5 000 000 × 100
    const cpuPct = ((deltaUser + deltaSys) / 5_000_000 * 100).toFixed(1);

    // ── Renderer + GPU metrics via Electron ──────────────────────────────
    const metrics = app.getAppMetrics();
    let rendererMem = '';
    let rendererCpu = '';
    let gpuMem      = '';
    let gpuCpu      = '';
    for (const m of Object.values(metrics)) {
      const mem   = fmtBytes((m.memory as any)?.residentSet ?? (m.memory as any)?.workingSetSize ?? 0);
      const cpu   = `${((m.cpu as any)?.percent ?? 0).toFixed(1)}%`;
      if (m.type === 'GPU')       { gpuMem = mem; gpuCpu = cpu; }
      if (m.type === 'Browser')   { rendererMem = mem; rendererCpu = cpu; }
    }

    // ── Spirit subsystem states ──────────────────────────────────────────
    const subsystems: string[] = [];
    if (isCursorTrackingActive())          subsystems.push('cursor');
    if (isPowerShellWorkerRunning())       subsystems.push('ps-worker');
    if (isLocalSttAvailable())             subsystems.push('stt:' + getSttStatus().phase);
    subsystems.push('sys-cpus:' + os.cpus().length);

    // console.log(
    //   `[resource] mainHeap=${fmtBytes(mainMem.heapUsed)}/${fmtBytes(mainMem.heapTotal)} ` +
    //   `rss=${fmtBytes(mainMem.rss)} ext=${fmtBytes(mainMem.external)} ` +
    //   `cpu=${cpuPct}% ` +
    //   `| renderer mem=${rendererMem} cpu=${rendererCpu} ` +
    //   `gpu mem=${gpuMem} cpu=${gpuCpu} ` +
    //   `| active=[${subsystems.join(', ')}]`,
    // );
  }, 5_000);

  // Allow clean shutdown
  app.on('before-quit', () => clearInterval(interval));
}

function applyGhostMode(enabled: boolean, hideTaskbar: boolean): void {
  setContentProtectionEnabled(enabled);
  setOverlaysSkipTaskbar(enabled && hideTaskbar);
  if (process.platform === 'darwin' && app.dock) {
    if (enabled && hideTaskbar) app.dock.hide();
    else app.dock.show();
  }
}

function startMainApp(): void {
  const ghost = getGhostMode();
  applyGhostMode(ghost, getGhostHideTaskbar());
  createOverlayForAllDisplays();
  if (!ghost) void createTray();
  // Warm the persistent PowerShell workers (context + selection) + prime the
  // CDP-owner cache in the background so the first trigger doesn't pay the
  // cold process starts or the ~1s TCP probe.
  primeWindowsContextCache();
  primePowerShellWorkers();

  // Ghost mode: the settings handler emits this after persisting; the
  // global hotkey is the escape hatch when the tray icon is hidden.
  app.on('spirit:ghost-mode' as never, (enabled: boolean) => {
    applyGhostMode(enabled, getGhostHideTaskbar());
    if (enabled) destroyTray();
    else void createTray();
  });
  if (
    !globalShortcut.register('CommandOrControl+Shift+G', () => {
      const next = !getGhostMode();
      setSettings({ ghostMode: next });
      app.emit('spirit:ghost-mode', next);
    })
  ) {
    console.warn('[main] could not register CommandOrControl+Shift+G');
  }

  // Local speech-to-text sidecar is LAZY: it spawns on the first voice
  // transcription that routes to local STT (see voice/transcribe.ts), not at
  // launch, and shuts itself down after 10m of disuse — an idle Spirit never
  // holds the python process or the Whisper model in memory.

  if (process.platform === 'darwin') {
    promptAccessibility();
    // Diagnose Screen Recording on startup. If missing, open System Settings once.
    canCaptureScreen().then((can) => {
      console.log('[main] screen recording effectively granted:', can);
      if (!can) {
        console.log('[main] opening Screen Recording settings (one-time auto-open)');
        void openSystemSettings('screen-recording');
      }
    });
  }

  if (!tryStartHook()) {
    console.log('[main] accessibility not granted, polling every 2s');
    hookRetryTimer = setInterval(() => {
      if (tryStartHook() && hookRetryTimer) {
        clearInterval(hookRetryTimer);
        hookRetryTimer = null;
      }
    }, 2000);
  }

  screen.on('display-added', () => {
    destroyAllOverlays();
    createOverlayForAllDisplays();
  });

  screen.on('display-removed', () => {
    destroyAllOverlays();
    createOverlayForAllDisplays();
  });

  // Resource debug logger — auto-enabled in dev (app.isPackaged=false),
  // or force-on with SPIRIT_DEBUG_RESOURCE=1 in production builds.
  if (process.env.SPIRIT_DEBUG_RESOURCE || !app.isPackaged) {
    startResourceDebugLogger();
    const reason = process.env.SPIRIT_DEBUG_RESOURCE ? 'SPIRIT_DEBUG_RESOURCE=1' : 'dev mode';
    console.log(`[main] resource debug logger enabled (${reason}, every 5 s)`);
  }
}

// Guard against double-invocation. macOS 'activate' fires when the dock
// icon is clicked or the app is foregrounded with no windows; the main
// 'ready' handler already calls setup() once, and a subsequent activate
// without windows would normally re-call it. Without this guard the IPC
// handlers register twice (Electron throws), and stale timers leak.
let setupCalled = false;

function setup(): void {
  if (setupCalled) return;
  setupCalled = true;
  registerIpcHandlers();
  checkLinuxDeps();
  // After app 'ready' so safeStorage reports encryption availability
  // correctly on Windows (before ready it is always "unavailable" and a
  // probe would falsely flag every stored key as broken).
  runProviderHealthProbe();

  startMainApp();
}

// Linux desktop actions (click/type/move/window-read) shell out to xdotool,
// an unbundled external dependency. Detect it once at startup and surface a
// clear message instead of every tool failing with ENOENT.
function checkLinuxDeps(): void {
  if (process.platform !== 'linux') return;
  const execFileP = promisify(execFile);
  void execFileP('xdotool', ['version'], { timeout: 3000, windowsHide: true })
    .then(() => console.log('[deps] xdotool found'))
    .catch(() =>
      console.warn(
        '[deps] xdotool is NOT installed — agent desktop actions will fail. ' +
          'Install it with: sudo apt install xdotool (Debian/Ubuntu) or ' +
          'sudo dnf install xdotool (Fedora), then restart Spirit.',
      ),
    );
}

// Last-resort safety net. The settings-store recovery path already absorbs
// the most likely crash class (legacy-encrypted config.json that can't be
// decrypted with the new envelope key). Anything else that throws during
// setup ends up here: we show a native dialog and offer to wipe the
// per-user data folder. The user restarts the app fresh.
async function handleFatalInitError(err: unknown): Promise<void> {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
  console.error('[main] fatal init error:', err);

  let choice: Electron.MessageBoxReturnValue;
  try {
    choice = await dialog.showMessageBox({
      type: 'error',
      title: 'Spirit could not start',
      message: 'Spirit ran into a problem while starting up.',
      detail:
        `${message}\n\n` +
        'You can reset Spirit to factory settings and quit. Your saved ' +
        'sessions in the workspace folder will not be touched, but your ' +
        'API keys and preferences will be cleared. After quitting, launch ' +
        'Spirit again to start fresh.',
      buttons: ['Reset settings and quit', 'Quit'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
  } catch {
    app.exit(1);
    return;
  }

  if (choice.response === 0) {
    try {
      const userData = app.getPath('userData');
      // app.getPath('userData') already points at the per-app folder
      // (e.g. ~/Library/Application Support/spirit). Wiping it removes
      // config.json, the secure-keys map, the icon cache, etc. Anything
      // the user stored under the workspace folder is in a different
      // location and is left alone.
      await fsp.rm(userData, { recursive: true, force: true });
      console.log(`[main] wiped userData at ${userData}`);
    } catch (wipeErr) {
      console.warn('[main] could not wipe userData:', wipeErr);
    }
  }
  app.exit(0);
}

app.whenReady().then(async () => {
  try {
    // A force-quit can orphan the driver daemon with its overlay on screen;
    // sweep it before anything spawns a fresh one.
    killStaleDriverProcesses((m) => console.log(m));
    // Sleep/wake: suspend kills the keyboard hook, the PowerShell workers'
    // pipes, and the overlay levels/frames — without recovery the box never
    // comes back and triggers go dead after wake. showInactive inside
    // restore never steals focus. Modern Standby often skips suspend/resume
    // entirely, so display-metrics changes run the same recovery.
    const recoverFromSleep = (why: string): void => {
      console.log(`[main] wake recovery (${why})`);
      try {
        restoreOverlaysAfterWake();
      } catch (err) {
        console.warn('[main] wake restore failed:', err instanceof Error ? err.message : err);
      }
      // uiohook frequently dies across suspend: restart hook + trigger.
      try {
        stopTriggerDetection();
      } catch {
        /* best effort */
      }
      try {
        stopGlobalHook();
      } catch {
        /* best effort */
      }
      if (!tryStartHook()) {
        console.warn('[main] wake recovery: hook did not restart (permissions?)');
      }
      // Sleep breaks worker pipes: fresh workers, then re-prime.
      try {
        cancelPowerShellIdleUnload();
        disposePowerShellWorker();
        primePowerShellWorkers();
      } catch (err) {
        console.warn('[main] wake recovery: workers failed:', err instanceof Error ? err.message : err);
      }
      // A pre-sleep crash can orphan the driver daemon with its overlay up.
      try {
        killStaleDriverProcesses((m) => console.log(m));
      } catch {
        /* best effort */
      }
    };
    powerMonitor.on('resume', () => recoverFromSleep('resume'));
    powerMonitor.on('suspend', () => console.log('[main] system suspend — recovery armed'));
    screen.on('display-metrics-changed', () => recoverFromSleep('display-metrics-changed'));
    setup();
  } catch (err) {
    await handleFatalInitError(err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) setup();
});

app.on('before-quit', () => {
  globalShortcut.unregister('CommandOrControl+Shift+G');
  runBeforeQuitHandlers();
  if (hookRetryTimer) {
    clearInterval(hookRetryTimer);
    hookRetryTimer = null;
  }
  stopCursorTracking();
  stopTriggerDetection();
  stopGlobalHook();
  stopLocalStt();
  destroyTray();
  destroyAboutWindow();
  destroyLegalWindow();
  destroyAllOverlays();
});
