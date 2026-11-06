import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Cross-platform system volume helpers. Best-effort: on Linux we try
// `pactl`, on Windows we use a PowerShell shim, on macOS we use
// osascript. Any failure returns a structured error string so the
// calling tool can report it back to the LLM/UI cleanly.

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

async function macSetLevel(level: number): Promise<void> {
  await execFileP('osascript', ['-e', `set volume output volume ${clamp(level, 0, 100)}`]);
}
async function macGetLevel(): Promise<number> {
  const { stdout } = await execFileP('osascript', ['-e', 'output volume of (get volume settings)']);
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 50;
}
async function macSetMuted(muted: boolean): Promise<void> {
  await execFileP('osascript', ['-e', `set volume ${muted ? 'with' : 'without'} output muted`]);
}

async function winSetLevel(level: number): Promise<void> {
  // PowerShell + WScript.Shell SendKeys is the most-portable no-extra-deps
  // path. Each VolumeDown/Up key adjusts by 2 units (0–50 range exposed by
  // the API), so we approximate by sending the diff. Crude but works
  // across Win10/11 without extra DLLs.
  const target = clamp(level, 0, 100);
  const steps = Math.max(0, Math.min(50, Math.round(target / 2)));
  const script = `
$wsh = New-Object -ComObject WScript.Shell
for ($i = 0; $i -lt 50; $i++) { $wsh.SendKeys([char]174) }
for ($i = 0; $i -lt ${steps}; $i++) { $wsh.SendKeys([char]175) }
`.trim();
  await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}
async function winAdjust(delta: number): Promise<void> {
  const steps = clamp(Math.round(Math.abs(delta) / 2), 0, 50);
  const key = delta >= 0 ? 175 : 174; // VK_VOLUME_UP / VK_VOLUME_DOWN
  const script = `
$wsh = New-Object -ComObject WScript.Shell
for ($i = 0; $i -lt ${steps}; $i++) { $wsh.SendKeys([char]${key}) }
`.trim();
  await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}
async function winMute(): Promise<void> {
  await execFileP('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]173)',
  ]);
}

async function linuxSetLevel(level: number): Promise<void> {
  await execFileP('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${clamp(level, 0, 100)}%`]);
}
async function linuxAdjust(delta: number): Promise<void> {
  const sign = delta >= 0 ? '+' : '-';
  await execFileP('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${sign}${Math.abs(delta)}%`]);
}
async function linuxMute(muted: boolean): Promise<void> {
  await execFileP('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']);
}

export async function setSystemVolume(args: {
  level?: number;
  delta?: number;
  action?: 'mute' | 'unmute';
}): Promise<{ ok: true; resultLevel?: number } | { ok: false; error: string }> {
  try {
    if (args.action === 'mute' || args.action === 'unmute') {
      const muted = args.action === 'mute';
      if (process.platform === 'darwin') await macSetMuted(muted);
      else if (process.platform === 'win32') await winMute();
      else if (process.platform === 'linux') await linuxMute(muted);
      else return { ok: false, error: 'Unsupported platform.' };
      return { ok: true };
    }
    if (typeof args.level === 'number') {
      const target = clamp(args.level, 0, 100);
      if (process.platform === 'darwin') await macSetLevel(target);
      else if (process.platform === 'win32') await winSetLevel(target);
      else if (process.platform === 'linux') await linuxSetLevel(target);
      else return { ok: false, error: 'Unsupported platform.' };
      return { ok: true, resultLevel: target };
    }
    if (typeof args.delta === 'number') {
      if (process.platform === 'darwin') {
        const cur = await macGetLevel();
        const next = clamp(cur + args.delta, 0, 100);
        await macSetLevel(next);
        return { ok: true, resultLevel: next };
      }
      if (process.platform === 'win32') {
        await winAdjust(args.delta);
        return { ok: true };
      }
      if (process.platform === 'linux') {
        await linuxAdjust(args.delta);
        return { ok: true };
      }
      return { ok: false, error: 'Unsupported platform.' };
    }
    return { ok: false, error: 'set_volume requires level, delta, or action.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
