// Persistent PowerShell workers — the fix for trigger-time lag.
//
// Every capture path (app-context, selected text) used to spawn a fresh
// powershell.exe per read. On Windows that process start alone costs
// ~0.8–1.2s, and the UIAutomation assemblies add another ~0.4–1.2s on top.
// The box-open path waited on one of these (Promise.all gate in main.ts), and
// the foreground watcher spawned a new one every second while the box was
// open — which is the "system slows down / mouse stutters right after the
// overlay appears" symptom: several cold PowerShell processes walking UIA
// trees simultaneously.
//
// This module instead keeps TWO long-lived `powershell -STA` processes alive
// and sends script requests to them over stdin:
//  - the CONTEXT worker serves app-context reads (identity + URL walk);
//  - the SELECTION worker serves selected-text reads.
// Two pools, because requests over one stdin pipe are strictly serialized:
// the box-open gate must never queue behind a slow selection read (and vice
// versa). UIAutomationClient/Types stay loaded in each process, so a read
// costs only the tree walk itself (~5ms for identity, ~1s worst case for a
// full browser BFS, ~35ms for a no-selection read). Requests are serialized
// per worker, each with its own timeout; on timeout or process death the
// worker is restarted lazily on the next request.
//
// Protocol:
//   Node -> worker:  one line = base64(UTF-8(script))
//   worker -> Node:  one line = "OK:" + base64(UTF-8(output))
//                 or "ERR:" + base64(UTF-8(message))
// The script must emit its result as pipeline output (e.g. a final
// `… | ConvertTo-Json -Compress`), NOT via [Console]::Out.Write, and must
// not call `exit` (that would kill the shared process).

import { spawn, type ChildProcess } from 'node:child_process';
import { onBeforeQuit } from '../lifecycle';

type PendingRequest = {
  script: string;
  timeoutMs: number;
  resolve: (out: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
};

const WORKER_TIMEOUT_MS = 8000;

// The long-running host script. Loads the expensive assemblies ONCE at
// startup so every later read skips Add-Type entirely.
function hostScript(prelude: string): string {
  return `
${prelude}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  try {
    $script = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))
    $sb = [scriptblock]::Create($script)
    $out = & $sb 2>&1 | Out-String
    $out = [string]$out
    [Console]::Out.WriteLine('OK:' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($out)))
  } catch {
    $msg = [string]$_.Exception.Message
    [Console]::Out.WriteLine('ERR:' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($msg)))
  }
  [Console]::Out.Flush()
}
`;
}

const CONTEXT_PRELUDE = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
Add-Type -Namespace SpiritFG -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
`;

// Capture host: System.Drawing loaded and the process made DPI-aware once, so
// every request is a region-direct GDI CopyFromScreen in this worker process —
// never on the main thread that drives the cursor heartbeat.
const CAPTURE_PRELUDE = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
Add-Type -Namespace SpiritCap -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[SpiritCap.Native]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing
`;

const HOST_SCRIPT = hostScript(CONTEXT_PRELUDE);
const CAPTURE_HOST_SCRIPT = hostScript(CAPTURE_PRELUDE);

function encodedHostScript(script: string): string {
  // -EncodedCommand expects base64 of UTF-16LE.
  return Buffer.from(script, 'utf16le').toString('base64');
}

interface WorkerPool {
  run: (script: string, timeoutMs: number) => Promise<string>;
  isRunning: () => boolean;
  dispose: () => void;
}

function createWorkerPool(hostScriptArg: string): WorkerPool {
  let child: ChildProcess | null = null;
  let stdoutBuf = '';
  let current: PendingRequest | null = null;
  const pendingQueue: PendingRequest[] = [];

  function spawnWorker(): void {
    if (child) return;
    stdoutBuf = '';
    current = null;
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodedHostScript(hostScriptArg)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr!.on('data', () => {
      /* diagnostics only — we never rely on stderr */
    });
    child.on('exit', () => {
      child = null;
      failAll(new Error('PowerShell worker exited'));
    });
    child.on('error', (err) => {
      child = null;
      failAll(err);
    });
  }

  function handleLine(line: string): void {
    const req = current;
    if (!req) return;
    current = null;
    if (req.timer) clearTimeout(req.timer);
    const idx = line.indexOf(':');
    const kind = idx > 0 ? line.slice(0, idx) : 'ERR';
    const payload = idx > 0 ? line.slice(idx + 1) : line;
    try {
      const text = Buffer.from(payload, 'base64').toString('utf8');
      if (kind === 'OK') req.resolve(text.trim());
      else req.reject(new Error(text || 'PowerShell script error'));
    } catch (err) {
      req.reject(err instanceof Error ? err : new Error('Bad worker response'));
    }
    pump();
  }

  function failAll(err: Error): void {
    if (current) {
      const req = current;
      current = null;
      if (req.timer) clearTimeout(req.timer);
      req.reject(err);
    }
    while (pendingQueue.length > 0) {
      const req = pendingQueue.shift()!;
      if (req.timer) clearTimeout(req.timer);
      req.reject(err);
    }
  }

  function pump(): void {
    if (!child || current) return;
    const req = pendingQueue.shift();
    if (!req) return;
    current = req;
    req.timer = setTimeout(() => {
      const stuck = current;
      current = null;
      if (stuck?.timer) clearTimeout(stuck.timer);
      // The worker may be wedged on a slow UIA call — kill it and respawn so
      // queued requests continue on a fresh process instead of queueing behind
      // a zombie.
      killWorker();
      stuck?.reject(new Error(`PowerShell worker timed out after ${req.timeoutMs}ms`));
      spawnWorker();
      pump();
    }, req.timeoutMs);
    try {
      child.stdin!.write(Buffer.from(req.script, 'utf8').toString('base64') + '\n');
    } catch (err) {
      killWorker();
      req.reject(err instanceof Error ? err : new Error('stdin write failed'));
    }
  }

  function killWorker(): void {
    if (child) {
      const c = child;
      child = null;
      try {
        c.kill();
      } catch {
        /* already dead */
      }
    }
    current = null;
  }

  function run(script: string, timeoutMs: number): Promise<string> {
    notePowerShellActivity();
    return new Promise<string>((resolve, reject) => {
      pendingQueue.push({ script, timeoutMs, resolve, reject, timer: null });
      spawnWorker();
      pump();
    });
  }

  return {
    run,
    isRunning: () => child !== null && child.exitCode === null,
    dispose: () => {
      killWorker();
      failAll(new Error('PowerShell worker disposed'));
    },
  };
}

const contextPool = createWorkerPool(HOST_SCRIPT);
const selectionPool = createWorkerPool(HOST_SCRIPT);
// Cursor-shape probes run on their own worker: the probe fires at ~20Hz while
// capture mode is active, and it must never queue behind (or delay) a click
// synthesis or a selection read on the shared pools.
const cursorPool = createWorkerPool(HOST_SCRIPT);
// Screen captures (GDI CopyFromScreen) run on their own worker too: the
// capture must never queue behind a slow UIA URL walk on the context worker,
// and its process is DPI-aware with System.Drawing preloaded.
const capturePool = createWorkerPool(CAPTURE_HOST_SCRIPT);

// Run one PowerShell script in the shared context worker. `script` must emit
// its result via pipeline output and must not `exit`.
export async function runPowerShell(script: string, timeoutMs = WORKER_TIMEOUT_MS): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('runPowerShell is Windows-only');
  }
  return contextPool.run(script, timeoutMs);
}

// Selected-text reads use a SEPARATE worker so the box-open gate (identity)
// never queues behind a slow selection read and vice versa.
export async function runSelectionPowerShell(script: string, timeoutMs = WORKER_TIMEOUT_MS): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('runSelectionPowerShell is Windows-only');
  }
  return selectionPool.run(script, timeoutMs);
}

// Cursor-shape probes (WM_SETCURSOR) use their own worker — see cursorPool.
export async function runCursorPowerShell(script: string, timeoutMs = 4000): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('runCursorPowerShell is Windows-only');
  }
  return cursorPool.run(script, timeoutMs);
}

// Screen captures use their own DPI-aware worker — see capturePool.
export async function runCapturePowerShell(script: string, timeoutMs = 15000): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('runCapturePowerShell is Windows-only');
  }
  return capturePool.run(script, timeoutMs);
}

export function isPowerShellWorkerRunning(): boolean {
  return contextPool.isRunning();
}

export function disposePowerShellWorker(): void {
  contextPool.dispose();
  selectionPool.dispose();
  cursorPool.dispose();
  capturePool.dispose();
}

// Warm ALL shared workers in the background at app start so the first reads
// don't pay the ~1.5s cold PowerShell start. The selection worker was already
// primed; the context worker is now primed too because the box-open path in
// main.ts issues an app-context read on the very first trigger — leaving it
// cold gated the box open behind a powershell.exe spawn and made the first
// trigger flaky. The capture worker is primed as well so the first screenshot
// after box-open doesn't pay the cold start. Best-effort; failures ignored
// (workers respawn lazily).
export function primePowerShellWorkers(): void {
  if (process.platform !== 'win32') return;
  notePowerShellActivity();
  void Promise.allSettled([
    contextPool.run('Write-Output "warm"', 10000),
    selectionPool.run('Write-Output "warm"', 10000),
    capturePool.run('Write-Output "warm"', 10000),
  ]);
}

// Adaptive idle unload: the persistent workers are the reason the first
// trigger after launch feels instant, but each holds tens of MB of
// PowerShell/UIAutomation/System.Drawing. After a long stretch with NO pool
// activity main can dispose them all (freeing the memory); the next trigger
// re-warms via primePowerShellWorkers(), so the cold start is hidden behind
// the box-open instead of costing the user a stall.
const IDLE_UNLOAD_MS = 10 * 60 * 1000;
let lastPoolActivityAt = 0;
let idleUnloadTimer: NodeJS.Timeout | null = null;

export function notePowerShellActivity(): void {
  lastPoolActivityAt = Date.now();
}

export function schedulePowerShellIdleUnload(): void {
  if (idleUnloadTimer) clearTimeout(idleUnloadTimer);
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    if (Date.now() - lastPoolActivityAt >= IDLE_UNLOAD_MS) {
      console.log('[ps-worker] no activity for 10m, unloading PowerShell workers');
      disposePowerShellWorker();
    }
  }, IDLE_UNLOAD_MS);
}

export function cancelPowerShellIdleUnload(): void {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

onBeforeQuit(() => {
  cancelPowerShellIdleUnload();
  disposePowerShellWorker();
});
