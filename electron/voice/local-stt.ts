import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setSettings } from '../store/settings';

// Manages the local faster-whisper/openai-whisper sidecar
// (electron/voice/local-whisper.py).
// The sidecar is LAZY: it spawns on the first voice transcription that routes
// to local STT, not at app launch, so an idle Spirit never holds a python
// process or its model in memory. It polls /health while starting and while
// the model is downloading/installing, then backs the poll way off once ready.
// If the sidecar goes unused for a long idle stretch it is stopped entirely
// (freed memory) and respawned lazily on the next use. If python or the script
// is missing the process reports not-available and the transcribe router falls
// back to cloud STT.
//
// Failure handling is designed to SELF-HEAL: a transient hiccup (python not
// yet on PATH, one bad spawn, an env change) must not silently kill local STT
// for the whole session. Spawn failures latch for only RETRY_COOLDOWN_MS, then
// the next voice use tries again — and every failed attempt is logged loudly
// with the reason, so a broken machine is diagnosed from the log alone.

const LOCAL_STT_HOST = '127.0.0.1';
// The sidecar used to live on a fixed well-known port (5100). That let an
// orphaned zombie sidecar — left behind when the app is killed hard
// (taskkill /F, closing the .bat window mid-run) — squat the port forever.
// Worse, Windows permits a *second* socket to bind the same loopback address,
// so a fresh sidecar and the zombie would BOTH listen: health probes
// round-robined onto the wedged zombie and local STT looked permanently
// "still starting". Every spawn now picks a free port in this range so a
// leftover listener can never collide, and orphans are reaped before spawn.
const STT_PORT_MIN = 5100;
const STT_PORT_MAX = 5900;
let activePort: number | null = null;

function currentPort(): number {
  return activePort ?? STT_PORT_MIN;
}

// Probe candidate ports: a connect that is REFUSED (fetch throws — and not a
// timeout) means nothing is listening there yet.
async function pickFreePort(): Promise<number> {
  for (let i = 0; i < 25; i++) {
    const port = STT_PORT_MIN + Math.floor(Math.random() * (STT_PORT_MAX - STT_PORT_MIN));
    try {
      const res = await fetch(`http://${LOCAL_STT_HOST}:${port}/health`, {
        signal: AbortSignal.timeout(400),
      });
      void res.body?.cancel(); // a server answered -> port taken, roll again
    } catch (err) {
      const name = (err as { name?: string } | undefined)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') continue;
      return port;
    }
  }
  return STT_PORT_MIN + Math.floor(Math.random() * (STT_PORT_MAX - STT_PORT_MIN));
}
const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 400;
const LOCAL_TIMEOUT_MS = 45_000;
// One model only: X-Turbo (Whisper large-v3-turbo). It is the same weights in
// every format, so the app never has to choose or download a lesser model.
// If X-Whisper is installed on this PC we reuse its GGML copy + whisper-cli
// (CUDA when present) with zero download; otherwise the sidecar pulls the CT2
// build of the same model through the existing downloader.
export const STT_MODEL_ID = 'turbo';
// Any stored value from older builds ("small", "base", …) normalizes here.
export function normalizeSttModelId(_raw: unknown): string {
  return STT_MODEL_ID;
}
function resolveSttModel(): string {
  return normalizeSttModelId(process.env.SPIRIT_STT_MODEL);
}

// X-Whisper reuse (read-only)
// X-Whisper (X-Studio-Labs) installs whisper.cpp under
// %LOCALAPPDATA%\X-Whisper\_up_\binaries\whisper-cpp\{cuda,vulkan,cpu}\ and
// models under %APPDATA%\X-Whisper\models\<name>\ggml-*.bin. We never write
// there — only reuse its binary + already-downloaded model.
export interface SttAssets {
  whisperCli: string | null;
  ggmlModel: string | null;
  ffmpeg: string | null;
  device: 'cuda' | 'vulkan' | 'cpu' | null;
  backend: 'whispercpp' | 'faster';
}

const WHISPER_CLI_NAMES = ['whisper-cli.exe', 'whisper-cli', 'main.exe', 'main'];
const GGML_MODEL_NAMES = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-large-v3-turbo-q5_0.bin',
];

function isFile(p: string | null | undefined): p is string {
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => isFile(p)) ?? null;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function appDataDirs(): { roaming: string; local: string } {
  const home = homedir();
  return {
    roaming: process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
    local: process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
  };
}

function xWhisperRoots(): string[] {
  const { roaming, local } = appDataDirs();
  return [
    join(local, 'X-Whisper', '_up_', 'binaries', 'whisper-cpp'),
    join(local, 'X-Whisper', 'binaries', 'whisper-cpp'),
    join(local, 'Programs', 'X-Whisper', 'binaries', 'whisper-cpp'),
    join(local, 'Programs', 'X-Whisper', 'whisper-cpp'),
    join(roaming, 'X-Whisper', 'binaries', 'whisper-cpp'),
  ];
}

function detectCliAt(root: string): { file: string; device: 'cuda' | 'vulkan' | 'cpu' } | null {
  for (const device of ['cuda', 'vulkan', 'cpu'] as const) {
    const file = firstExisting(WHISPER_CLI_NAMES.map((n) => join(root, device, n)));
    if (file) return { file, device };
  }
  const direct = firstExisting(WHISPER_CLI_NAMES.map((n) => join(root, n)));
  if (direct) {
    const lower = direct.toLowerCase();
    const device = lower.includes('cuda')
      ? 'cuda'
      : lower.includes('vulkan')
        ? 'vulkan'
        : 'cpu';
    return { file: direct, device };
  }
  return null;
}

function detectWhisperCli(): { file: string; device: 'cuda' | 'vulkan' | 'cpu' } | null {
  const override = process.env.SPIRIT_STT_WHISPER_CLI;
  if (override) {
    try {
      if (statSync(override).isDirectory()) {
        const hit = detectCliAt(override);
        if (hit) return hit;
      } else if (isFile(override)) {
        const lower = override.toLowerCase();
        const device = lower.includes('cuda')
          ? 'cuda'
          : lower.includes('vulkan')
            ? 'vulkan'
            : 'cpu';
        return { file: override, device };
      }
    } catch {
      /* ignore bad override */
    }
  }
  for (const root of xWhisperRoots()) {
    const hit = detectCliAt(root);
    if (hit) return hit;
  }
  return null;
}

function detectGgmlModel(): string | null {
  const override = process.env.SPIRIT_STT_GGML_MODEL;
  if (isFile(override)) return override;
  const { roaming, local } = appDataDirs();
  const roots = [
    join(roaming, 'X-Whisper', 'models'),
    join(local, 'X-Whisper', 'models'),
    join(roaming, 'X-Whisper'),
    join(local, 'Spirit', 'models'),
  ];
  for (const root of roots) {
    const direct = firstExisting(GGML_MODEL_NAMES.map((n) => join(root, n)));
    if (direct) return direct;
    for (const dir of subdirs(root)) {
      const nested = firstExisting(GGML_MODEL_NAMES.map((n) => join(dir, n)));
      if (nested) return nested;
    }
  }
  return null;
}

function detectFfmpeg(): string | null {
  const override = process.env.SPIRIT_STT_FFMPEG;
  if (isFile(override)) return override;
  const { roaming, local } = appDataDirs();
  const bundled = [
    join(local, 'X-Whisper', '_up_', 'binaries', 'ffmpeg', 'ffmpeg.exe'),
    join(local, 'X-Whisper', 'binaries', 'ffmpeg', 'ffmpeg.exe'),
    join(local, 'Programs', 'X-Whisper', 'binaries', 'ffmpeg', 'ffmpeg.exe'),
    join(roaming, 'X-Whisper', 'binaries', 'ffmpeg', 'ffmpeg.exe'),
  ];
  const bundledHit = firstExisting(bundled);
  if (bundledHit) return bundledHit;
  try {
    const out = execFileSync('where.exe', ['ffmpeg'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (isFile(p)) return p;
    }
  } catch {
    /* no system ffmpeg */
  }
  return null;
}

export function detectSttAssets(): SttAssets {
  const cli = detectWhisperCli();
  const ggmlModel = detectGgmlModel();
  const whisperCli = cli?.file ?? null;
  return {
    whisperCli,
    ggmlModel,
    ffmpeg: detectFfmpeg(),
    device: cli?.device ?? null,
    backend: whisperCli && ggmlModel ? 'whispercpp' : 'faster',
  };
}

// The sidecar polls its own status fast only while there is something the
// renderer's "STT setup" capsule needs to show (download/install), then once a
// minute as a liveness check once the model is ready.
const STATUS_POLL_BUSY_MS = 600;
const STATUS_POLL_IDLE_MS = 30_000;

// Stop the sidecar after this long with no transcription, freeing the python
// process + loaded model. Lazy respawn keeps the next use working.
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

export type SttStatus = {
  // idle | downloading | installing | ready | unavailable
  phase: string;
  // 0..100 byte-level download progress, or null when not downloading.
  progress: number | null;
  model: string | null;
  ready: boolean;
  // Sidecar is spawned + healthy (server answering). The model may still be
  // loading — `ready` flips later. Live slices use this to route local as soon
  // as the sidecar EXISTS, so they don't waste the first chunk on cloud.
  available: boolean;
  // Which engine is actually serving this sidecar ('whispercpp' | 'faster').
  backend?: string | null;
  // 'cuda' | 'vulkan' | 'cpu' when the whisper.cpp backend is in use.
  device?: string | null;
  // Set when the model download gave up after retries (phase 'error').
  downloadError?: string | null;
};

let child: ChildProcess | null = null;
let healthy = false;
let startPromise: Promise<boolean> | null = null;
// Model the running sidecar was spawned with (resolveSttModel at spawn).
// Null until first spawn. Switching = stopLocalStt + startLocalStt.
let activeModel: string | null = null;
// Last time python failed to spawn. Only LATches for a short cooldown: after
// RETRY_COOLDOWN_MS the next voice use tries again, so a transient failure
// (python not on PATH at launch, PATH edited, one flaky first spawn) heals
// itself instead of silently killing local STT for the whole session.
let spawnFailedMissingPythonAt: number | null = null;
const RETRY_COOLDOWN_MS = 60_000;
let statusPoller: NodeJS.Timeout | null = null;
let idleShutdownTimer: NodeJS.Timeout | null = null;
let status: SttStatus = {
  phase: 'idle',
  progress: null,
  model: null,
  ready: false,
  available: false,
};

// The python script ships inside the app (asar in production). External
// processes can't read asar, so we stage a copy into userData and spawn
// that. Source candidates cover dev (project tree) and dist-electron.
function getLocalSttScriptPath(): string {
  const candidates = [
    join(__dirname, 'local-whisper.py'),
    join(app.getAppPath(), 'electron', 'voice', 'local-whisper.py'),
    join(process.cwd(), 'electron', 'voice', 'local-whisper.py'),
  ];
  const src = candidates.find((p) => existsSync(p));
  if (!src) return '';

  const dest = join(app.getPath('userData'), 'local-whisper.py');
  try {
    if (
      !existsSync(dest) ||
      statSync(src).mtimeMs > statSync(dest).mtimeMs
    ) {
      copyFileSync(src, dest);
    }
    return dest;
  } catch (err) {
    console.warn('[local-stt] could not stage sidecar script, using source:', err);
    return src;
  }
}

// A sidecar orphaned by a hard app kill never got stopLocalStt()'s kill — it
// survives, holding python + a loaded model (hundreds of MB) forever. Reap ANY
// leftover sidecar just before spawning a fresh one. Matches the script path
// so unrelated python processes are never touched. Best-effort: failures log
// and the spawn proceeds regardless.
function reapStaleSidecars(): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*local-whisper.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
  } catch (err) {
    console.warn('[local-stt] could not reap stale sidecars:', err);
  }
}

function spawnPython(scriptPath: string, port: number): Promise<ChildProcess> {
  // Bare names first (fast, honors PATH), then absolute paths resolved via
  // `where` as a hedge against an Electron environment whose PATH differs from
  // the shell — the Windows Store python alias is a classic example.
  const candidates: string[] =
    process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  if (process.platform === 'win32') {
    for (const name of ['python', 'python3', 'py']) {
      try {
        const out = execFileSync('where.exe', [name], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        for (const line of out.split(/\r?\n/)) {
          const p = line.trim();
          if (p && !candidates.includes(p)) candidates.push(p);
        }
      } catch {
        /* not installed */
      }
    }
  }
  return new Promise((resolve, reject) => {
    let idx = 0;
    const attempt = (): void => {
      if (idx >= candidates.length) {
        spawnFailedMissingPythonAt = Date.now();
        reject(
          new Error(
            `no python interpreter found on PATH (tried: ${candidates.join(', ')}). ` +
              'Local STT needs Python 3.9+ with flask + faster-whisper (see scripts/install-stt.ps1).',
          ),
        );
        return;
      }
      const cmd = candidates[idx++];
      let proc: ChildProcess;
      console.log(`[local-stt] spawn attempt: ${cmd}`);
      try {
      // Resolve X-Whisper assets per spawn: if it was installed/uninstalled
      // while Spirit stayed open, the next lazy spawn picks the change up.
      // The sidecar reuses its GGML model + whisper-cli (CUDA when present)
      // instead of downloading anything.
      const assets = detectSttAssets();
      proc = spawn(
        cmd,
        [scriptPath, '--host', LOCAL_STT_HOST, '--port', String(port)],
        {
          env: {
            ...process.env,
            SPIRIT_STT_MODEL: resolveSttModel(),
            SPIRIT_STT_BACKEND: assets.backend,
            ...(assets.whisperCli ? { SPIRIT_STT_WHISPER_CLI: assets.whisperCli } : {}),
            ...(assets.ggmlModel ? { SPIRIT_STT_GGML_MODEL: assets.ggmlModel } : {}),
            ...(assets.ffmpeg ? { SPIRIT_STT_FFMPEG: assets.ffmpeg } : {}),
            ...(assets.device ? { SPIRIT_STT_WC_DEVICE: assets.device } : {}),
          },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
      } catch (err) {
        console.warn(`[local-stt] spawn threw for '${cmd}':`, err);
        attempt();
        return;
      }
      proc.stdout?.on('data', (d: Buffer) => console.log(`[local-stt] ${String(d).trimEnd()}`));
      proc.stderr?.on('data', (d: Buffer) => console.warn(`[local-stt] ${String(d).trimEnd()}`));
      const onError = (err: NodeJS.ErrnoException): void => {
        proc.removeListener('spawn', onSpawn);
        if (err.code === 'ENOENT') {
          console.warn(`[local-stt] '${cmd}' not found (ENOENT)`);
          attempt();
        } else {
          reject(err);
        }
      };
      const onSpawn = (): void => {
        proc.removeListener('error', onError);
        resolve(proc);
      };
      proc.once('error', onError);
      proc.once('spawn', onSpawn);
    };
    attempt();
  });
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const port = currentPort();
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  let polls = 0;
  console.log(`[local-stt] health wait start port=${port} timeout=${timeoutMs}ms`);
  while (Date.now() < deadline) {
    polls++;
    try {
      const res = await fetch(`http://${LOCAL_STT_HOST}:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; pid?: number };
        if (json.ok) {
          console.log(
            `[local-stt] health ok port=${port} polls=${polls} pid=${json.pid ?? '?'}`,
          );
          return true;
        }
        lastErr = `ok=false body=${JSON.stringify(json)}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  console.warn(
    `[local-stt] health wait timed out port=${port} polls=${polls} last=${lastErr}`,
  );
  return false;
}

// Best-effort start; never rejects (callers treat false as "use cloud").
export async function startLocalStt(): Promise<boolean> {
  // startPromise MUST be checked before `child`: the process is assigned as
  // soon as spawn fires, but healthy stays false until waitForHealth finishes.
  // Concurrent transcribe/warm calls used to hit `if (child) return healthy`
  // and get false while the first call was still polling — every live slice
  // then routed to cloud and failed with "no API key".
  if (startPromise) return startPromise;
  if (child) return healthy;
  // Cooldown, not a permanent latch: after a python-missing failure, retry on
  // the next voice use once RETRY_COOLDOWN_MS has elapsed.
  if (spawnFailedMissingPythonAt && Date.now() - spawnFailedMissingPythonAt < RETRY_COOLDOWN_MS) {
    return false;
  }
  spawnFailedMissingPythonAt = null;

  startPromise = (async () => {
    const scriptPath = getLocalSttScriptPath();
    if (!scriptPath) {
      console.warn('[local-stt] sidecar script not found; local STT unavailable');
      healthy = false;
      startPromise = null; // don't latch — re-check on the next voice use
      return false;
    }
    try {
      // Old tiny/base/small/medium/large-v3 weights are dead disk now; the
      // single-model cleanup runs once per install before the first spawn.
      ensureSttCacheCleanup();
      // Free ephemeral port FIRST (a stale zombie could still be answering on
      // the old fixed port), then clear out orphaned sidecars from prior
      // hard-killed sessions so they don't leak python + model memory.
      activePort = await pickFreePort();
      reapStaleSidecars();
      activeModel = resolveSttModel();
      const proc = await spawnPython(scriptPath, activePort);
      child = proc;
      console.log(`[local-stt] sidecar pid=${proc.pid} port=${activePort}`);
      proc.on('exit', (code, signal) => {
        console.warn(`[local-stt] sidecar exited code=${code} signal=${signal}`);
        if (child === proc) {
          child = null;
          healthy = false;
          activePort = null;
          startPromise = null;
          spawnFailedMissingPythonAt = null;
          stopStatusPoller();
          clearIdleShutdownTimer();
          status = { phase: 'unavailable', progress: null, model: null, ready: false, available: false };
        }
      });
      healthy = await waitForHealth(HEALTH_TIMEOUT_MS);
      if (!healthy) {
        console.warn('[local-stt] sidecar did not become healthy; stopping it');
        stopLocalStt();
        return false;
      }
      console.log('[local-stt] sidecar healthy');
      status = { ...status, available: true };
      startStatusPoller();
      scheduleIdleShutdown();
      return true;
    } catch (err) {
      console.warn('[local-stt] could not start:', err);
      healthy = false;
      child = null;
      startPromise = null;
      return false;
    }
  })();

  return startPromise;
}

export function isLocalSttAvailable(): boolean {
  return healthy && child !== null;
}

// Why local STT isn't usable right now — logged by the transcribe router so a
// fallback to cloud always shows its cause in the log (never a silent "routing
// to cloud").
export function getLocalSttUnavailableReason(): string | null {
  if (isLocalSttAvailable()) return null;
  if (spawnFailedMissingPythonAt) return 'python not found on PATH';
  if (startPromise || child) return 'sidecar still starting';
  return 'sidecar not running';
}

// Forward the sidecar's live model-download phase/progress to the renderer.
// The renderer polls this while a voice transcription is in flight so the
// first-use model download ("STT setup 46%") shows in the prompt capsule.
export function getSttStatus(): SttStatus {
  return status;
}

function startStatusPoller(): void {
  if (statusPoller) return;
  statusPoller = setTimeout(statusPollerTick, 0);
}

async function statusPollerTick(): Promise<void> {
  statusPoller = null;
  if (!isLocalSttAvailable()) return;
  try {
    const res = await fetch(`http://${LOCAL_STT_HOST}:${currentPort()}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        phase?: string;
        download_progress?: number | null;
        download_error?: string | null;
        model?: string | null;
        ready?: boolean;
        backend?: string | null;
        device?: string | null;
      };
      status = {
        phase: json.phase ?? 'idle',
        progress:
          typeof json.download_progress === 'number'
            ? Math.max(0, Math.min(100, json.download_progress))
            : null,
        model: json.model ?? null,
        ready: json.ready === true,
        available: true,
        backend: typeof json.backend === 'string' ? json.backend : null,
        device: typeof json.device === 'string' ? json.device : null,
        downloadError: typeof json.download_error === 'string' ? json.download_error : null,
      };
    }
  } catch {
    /* sidecar may be mid-restart */
  }
  scheduleStatusPoll();
}

// Poll fast while the first-use model download/install is progressing (the
// renderer's "STT setup 46%" capsule reads getSttStatus), then back off hard
// to a once-a-minute liveness check once the model is ready.
function scheduleStatusPoll(): void {
  if (statusPoller) return;
  const busy = status.phase === 'downloading' || status.phase === 'installing' || !status.ready;
  statusPoller = setTimeout(statusPollerTick, busy ? STATUS_POLL_BUSY_MS : STATUS_POLL_IDLE_MS);
}

function stopStatusPoller(): void {
  if (statusPoller) {
    clearTimeout(statusPoller);
    statusPoller = null;
  }
}

// After a long stretch with no transcription, stop the sidecar so an idle
// Spirit doesn't keep a python process + loaded Whisper model resident. Next
// use lazily respawns it. Never fires while the model is still downloading —
// killing that would abort a first-use setup the user is watching.
function scheduleIdleShutdown(): void {
  clearIdleShutdownTimer();
  idleShutdownTimer = setTimeout(() => {
    idleShutdownTimer = null;
    if (status.ready && isLocalSttAvailable()) {
      console.log('[local-stt] idle for 10m, stopping sidecar');
      stopLocalStt();
    }
  }, IDLE_SHUTDOWN_MS);
}

function clearIdleShutdownTimer(): void {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

export function stopLocalStt(): void {
  const proc = child;
  child = null;
  healthy = false;
  activePort = null;
  startPromise = null;
  stopStatusPoller();
  clearIdleShutdownTimer();
  if (status.available || status.ready) {
    status = { ...status, phase: 'unavailable', available: false, ready: false };
  }
  if (proc && !proc.killed) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}

export interface LocalSttResult {
  text: string;
  // 2-letter code Whisper detected (or was told). Null when unknown —
  // the renderer pins the first confident code for the rest of the
  // session so per-slice auto-detect can't flip-flop languages.
  language: string | null;
}

export async function transcribeLocal(
  audioBase64: string,
  mimeType: string,
  language?: string,
  prompt?: string,
  fast = false,
): Promise<LocalSttResult> {
  if (!isLocalSttAvailable()) {
    throw new Error('local STT sidecar is not running');
  }
  // Every transcription resets the idle-shutdown window.
  scheduleIdleShutdown();
  const binary = Buffer.from(audioBase64, 'base64');
  const params: string[] = [];
  if (language && language !== 'auto') params.push(`language=${encodeURIComponent(language)}`);
  // Phase 7: the running live transcript acts as Whisper's initial_prompt —
  // context that fights hallucinations and pins the language for multilingual.
  if (prompt && prompt.trim()) params.push(`prompt=${encodeURIComponent(prompt.trim())}`);
  // Phase 7: interim live chunks love beam_size=1 speed; the authoritative tail
  // keeps beam_size=5 accuracy.
  if (fast) params.push('fast=1');
  const query = params.length ? `?${params.join('&')}` : '';
  const res = await fetch(`http://${LOCAL_STT_HOST}:${currentPort()}/transcribe${query}`, {
    method: 'POST',
    headers: { 'Content-Type': mimeType.split(';')[0].trim() },
    body: binary,
    signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`local STT ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { text?: string; error?: string; language?: string | null };
  if (json.error) throw new Error(json.error);
  return { text: (json.text ?? '').trim(), language: json.language ?? null };
}

// Speech-model manager (Settings → Voice)

export interface SttModelInfo {
  id: string;
  // Approx download size, shown before downloading.
  sizeMB: number;
  // One-line caveat shown under the name.
  note: string;
  downloaded: boolean;
  // A cache dir exists but holds no model file (failed/interrupted
  // download the sidecar hasn't wiped, e.g. app killed mid-run). The UI
  // shows "Incomplete" and Download retries cleanly over it.
  partial: boolean;
  // Actual MB on disk (0 when not downloaded).
  diskMB: number;
  active: boolean;
  recommended: boolean;
}

// The CT2 fallback for the same large-v3-turbo weights. `turbo` is valid
// shorthand inside faster-whisper itself, but Spirit's cache paths must use
// the real repo id — the old hardcoded `Systran/faster-whisper-turbo` never
// existed on HuggingFace.
const CT2_TURBO_REPO = 'mobiuslabsgmbh/faster-whisper-large-v3-turbo';
const CT2_TURBO_SIZE_MB = 1624;
const TURBO_IDS = new Set(['turbo', 'x-turbo', 'xturbo', 'large-v3-turbo', 'large-v3_turbo']);

function isTurboId(id: unknown): boolean {
  return typeof id === 'string' && TURBO_IDS.has(id.trim().toLowerCase());
}

function sttCacheDir(): string {
  return (
    process.env.SPIRIT_STT_CACHE_DIR ?? join(homedir(), '.cache', 'huggingface', 'hub')
  );
}

function ct2TurboDir(): string {
  return join(sttCacheDir(), `models--${CT2_TURBO_REPO.replace('/', '--')}`);
}

function fileSizeMB(file: string): number {
  try {
    return Math.round(statSync(file).size / 1024 / 1024);
  } catch {
    return 0;
  }
}

function dirSizeMB(dir: string): number {
  let bytes = 0;
  try {
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      let entries: string[] = [];
      try {
        entries = readdirSync(cur);
      } catch {
        continue;
      }
      for (const name of entries) {
        const p = join(cur, name);
        try {
          const st = statSync(p);
          if (st.isDirectory()) stack.push(p);
          else bytes += st.size;
        } catch {
          /* ignore vanishing files */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return Math.round(bytes / 1024 / 1024);
}

function ct2TurboReady(): boolean {
  const dir = ct2TurboDir();
  return existsSync(dir) && snapshotHasModel(dir);
}

// One-line source/status line for Settings → Voice. There is exactly one
// model now, so this reports where it comes from rather than a pick.
export function recommendSttModel(): { id: string; line: string } {
  const assets = detectSttAssets();
  if (assets.backend === 'whispercpp') {
    const device = (assets.device ?? 'cpu').toUpperCase();
    return {
      id: STT_MODEL_ID,
      line: `Using your X-Whisper install: X-Turbo on ${device} — nothing to download.`,
    };
  }
  if (ct2TurboReady()) {
    return { id: STT_MODEL_ID, line: 'X-Turbo is ready — local STT loads from cache.' };
  }
  return {
    id: STT_MODEL_ID,
    line: 'X-Turbo (large-v3-turbo) downloads once (~1.6 GB). X-Whisper not detected.',
  };
}

export function listSttModels(): { models: SttModelInfo[]; recommendation: string } {
  ensureSttCacheCleanup();
  const assets = detectSttAssets();
  const rec = recommendSttModel();
  const ct2DirExists = existsSync(ct2TurboDir());
  const cached = ct2DirExists && snapshotHasModel(ct2TurboDir());
  const xReady = assets.backend === 'whispercpp';
  const downloaded = xReady || cached;
  let diskMB = 0;
  if (xReady && assets.ggmlModel) diskMB = fileSizeMB(assets.ggmlModel);
  else if (cached) diskMB = dirSizeMB(ct2TurboDir());
  const partial = !downloaded && ct2DirExists;
  const note = xReady
    ? `Reusing X-Whisper's X-Turbo on ${(assets.device ?? 'cpu').toUpperCase()} — no download.`
    : cached
      ? 'X-Turbo is cached locally — no download needed.'
      : 'X-Turbo (large-v3-turbo): best accuracy, downloads once (~1.6 GB).';
  const models: SttModelInfo[] = [
    {
      id: STT_MODEL_ID,
      sizeMB: CT2_TURBO_SIZE_MB,
      note,
      downloaded,
      partial,
      diskMB,
      active: true,
      recommended: true,
    },
  ];
  return { models, recommendation: rec.line };
}

// One-time legacy cache cleanup
// Older builds shipped a tiny/base/small/medium/large-v3 picker. Those
// weights are now dead disk: remove ONLY Spirit's own HF cache entries. The
// openai-whisper `~/.cache/whisper` files and everything under X-Whisper are
// other tools' property and are never touched.
const LEGACY_STT_REPOS = ['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3', 'turbo'];
let sttCleanupChecked = false;

function sttCleanupMarker(): string {
  return join(app.getPath('userData'), 'stt-cache-cleanup.v1');
}

export function ensureSttCacheCleanup(): void {
  if (sttCleanupChecked) return;
  sttCleanupChecked = true;
  try {
    if (existsSync(sttCleanupMarker())) return;
  } catch {
    /* app path unavailable (tests) — still run the scan */
  }
  const cache = sttCacheDir();
  let removed = 0;
  let freedMB = 0;
  for (const id of LEGACY_STT_REPOS) {
    // The live turbo cache lives under CT2_TURBO_REPO's real id, so wiping
    // the legacy `Systran/...-turbo` directory can never delete it.
    const dir = join(cache, `models--Systran--faster-whisper-${id}`);
    if (!existsSync(dir)) continue;
    freedMB += dirSizeMB(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      /* in use / permission — retry next launch */
    }
  }
  if (removed > 0) {
    console.log(`[local-stt] removed ${removed} legacy STT cache(s), freed ~${freedMB} MB`);
  }
  try {
    setSettings({ sttModel: STT_MODEL_ID });
  } catch {
    /* settings unavailable */
  }
  try {
    writeFileSync(sttCleanupMarker(), new Date().toISOString(), 'utf8');
  } catch {
    /* marker is best-effort */
  }
}

// True when <repoDir>/snapshots/*/ holds a model file (mirrors the
// sidecar's _snapshot_has_model so both sides agree on "downloaded").
function snapshotHasModel(repoDir: string): boolean {
  let snaps: string[] = [];
  try {
    snaps = readdirSync(join(repoDir, 'snapshots'));
  } catch {
    return false;
  }
  for (const s of snaps) {
    let files: string[] = [];
    try {
      files = readdirSync(join(repoDir, 'snapshots', s));
    } catch {
      continue;
    }
    if (files.some((f) => f === 'model.bin' || f.endsWith('.onnx') || f === 'model.safetensors')) {
      return true;
    }
  }
  return false;
}

// Delete the downloaded CT2 copy. X-Whisper's model is not ours to delete,
// and the model in use can't be removed mid-session.
export function deleteSttModel(id: string): { ok: boolean; error?: string } {
  if (!isTurboId(id)) return { ok: false, error: `unknown model "${id}"` };
  const assets = detectSttAssets();
  if (assets.backend === 'whispercpp') {
    return { ok: false, error: 'X-Turbo comes from X-Whisper — remove it there' };
  }
  if (isLocalSttAvailable()) {
    return { ok: false, error: 'X-Turbo is in use — stop local STT first' };
  }
  const repoDir = ct2TurboDir();
  if (!existsSync(repoDir)) return { ok: true };
  try {
    rmSync(repoDir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Switch = stop the sidecar + respawn. Present for the Settings IPC surface;
// with one model it only forces a fresh load (re-detects X-Whisper assets).
export async function switchSttModel(id: string): Promise<boolean> {
  if (!isTurboId(id)) return false;
  stopLocalStt();
  activeModel = STT_MODEL_ID;
  return startLocalStt();
}

export function getActiveSttModel(): string {
  return activeModel ?? resolveSttModel();
}
