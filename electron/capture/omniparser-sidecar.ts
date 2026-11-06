// OmniParser sidecar provider — spawns scripts/omniparser_sidecar.py once per
// screenshot and reads one JSON line of detections off stdout. No persistent
// server, no port: a python process runs only while a screenshot is being
// examined and exits, so an idle Spirit holds zero python footprint (potato-PC
// friendly, same lazy philosophy as local-stt).
//
// Availability is deliberate and explicit:
//   - the sidecar script (ships in this repo at scripts/omniparser_sidecar.py),
//   - a Python interpreter on PATH,
//   - an OmniParser V2/V3 checkout, whose URL is wired to the script via the
//     omniparser dir (SPIRIT_OMNIPARSER_DIR) — the model weights stay OUT of
//     this repo, exactly like tesseract/whisper.
// Anything missing -> unavailable -> the pipeline silently keeps its current
// behavior. A hard runtime failure (bad python, crash, unparseable output)
// latches unavailable for the session so we never spawn a dead process per tag.
//
// Exported pure-ish seams (parseSidecarOutput, a configurable runner) keep the
// detections->objects mapping testable without a real python install.

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DetectedObject, GroundingProvider } from './visual-grounding';

const execFileP = promisify(execFile);
const DETECT_TIMEOUT_MS = 90_000;

export type SidecarRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; code: number }>;

const defaultRunner: SidecarRunner = async (cmd, args, timeoutMs) => {
  try {
    const { stdout } = await execFileP(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: String(stdout), code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { stdout: String(e.stdout ?? ''), code: typeof e.code === 'number' ? e.code : 1 };
  }
};

export type OmniParserConfig = {
  scriptPath?: string;
  dir?: string;
  runner?: SidecarRunner;
};

// The sidecar script path: an explicit env override wins; otherwise the copy
// that ships in the package (resources/scripts) or lives in the dev checkout.
export function omniParserScriptPath(): string {
  const env = process.env.SPIRIT_OMNIPARSER_SCRIPT?.trim();
  if (env) return env;
  const packaged = join(process.resourcesPath ?? '', 'scripts', 'omniparser_sidecar.py');
  if (existsSync(packaged)) return packaged;
  return join(process.cwd(), 'scripts', 'omniparser_sidecar.py');
}

// Candidate OmniParser checkout dirs: explicit env pointer, then the usual
// clone locations. Detection is existence-only (any of the repo's entry-point
// folders); the script itself reports if internals are missing.
export function omniParserDirCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const home = platform === 'win32' ? process.env.USERPROFILE ?? homedir() : homedir();
  return [
    process.env.SPIRIT_OMNIPARSER_DIR ?? '',
    join(home, 'OmniParser'),
    join(home, 'omniparser'),
  ].filter(Boolean);
}

export function resolveOmniParserSidecar(): {
  script: string;
  dir: string;
  pythonCmd: string;
} | null {
  const script = omniParserScriptPath();
  if (!existsSync(script)) return null;
  const dir = omniParserDirCandidates().find((d) => existsSync(d));
  if (!dir) return null;
  const pythonCmd = resolvePythonCmd();
  if (!pythonCmd) return null;
  return { script, dir, pythonCmd };
}

let cachedPythonCmd: string | null | undefined;
function resolvePythonCmd(): string | null {
  if (cachedPythonCmd !== undefined) return cachedPythonCmd;
  // First try 'python' (Windows/conda), then 'python3' (macOS/Linux). The
  // sidecar handles the PyTorch/onnxruntime import errors itself and prints a
  // machine-readable failure; here we only need SOMETHING that runs py3.
  cachedPythonCmd = null;
  for (const cmd of ['python', 'python3']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import sys; sys.exit(0)'], {
        timeout: 10_000,
        windowsHide: true,
      });
      if (r.error === undefined && r.status === 0) {
        cachedPythonCmd = cmd;
        break;
      }
    } catch {
      /* try next */
    }
  }
  return cachedPythonCmd;
}

// Parse the sidecar's LAST JSON line on stdout into DetectedObject[] in the
// image's pixel space. Pure — unit-tested.
export function parseSidecarOutput(
  stdout: string,
  imgW: number,
  imgH: number,
): DetectedObject[] | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  if (lines.length === 0) return null;
  let data: { ok?: boolean; error?: string; objects?: { label?: string; box?: number[] }[] };
  try {
    data = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
  if (!data.ok || !Array.isArray(data.objects)) return null;
  const objects: DetectedObject[] = [];
  for (const o of data.objects) {
    const b = o.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) continue;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label) continue;
    objects.push({
      label,
      box: [
        Math.min(imgW, Math.max(0, b[0])),
        Math.min(imgH, Math.max(0, b[1])),
        Math.min(imgW, Math.max(0, b[2])),
        Math.min(imgH, Math.max(0, b[3])),
      ],
    });
  }
  return objects;
}

export function omniparserProvider(cfg: OmniParserConfig = {}): GroundingProvider {
  const runner = cfg.runner ?? defaultRunner;
  let lastError: string | null = null;
  let hardFailed = false;

  const snapshot = (): {
    script: string;
    dir: string;
    pythonCmd: string;
  } | null => {
    if (hardFailed) return null;
    const s = cfg.scriptPath ?? omniParserScriptPath();
    if (!existsSync(s)) {
      lastError = 'omniparser sidecar script not found';
      return null;
    }
    const dir = (cfg.dir ?? omniParserDirCandidates().find((d) => existsSync(d))) ?? '';
    if (!dir || !existsSync(dir)) {
      lastError = 'OmniParser checkout not found (set SPIRIT_OMNIPARSER_DIR or clone into home)';
      return null;
    }
    const pythonCmd = resolvePythonCmd();
    if (!pythonCmd) {
      lastError = 'no python interpreter on PATH';
      return null;
    }
    lastError = null;
    return { script: s, dir, pythonCmd };
  };

  const provider: GroundingProvider = {
    source: 'omniparser',
    isAvailable: () => snapshot() !== null,
    lastError: () => lastError,
    async detect(imagePath, imgW, imgH) {
      const s = snapshot();
      if (!s) return null;
      const { stdout, code } = await runner(
        s.pythonCmd,
        [s.script, '--image', imagePath, '--width', String(imgW), '--height', String(imgH), '--dir', s.dir],
        DETECT_TIMEOUT_MS,
      );
      const objects = parseSidecarOutput(stdout, imgW, imgH);
      if (code !== 0 || objects === null) {
        lastError = `sidecar failed (code=${code}): ${stdout.split(/\r?\n/)[0] ?? 'no output'}`;
        hardFailed = true; // don't retry dead python every tag this session
        return null;
      }
      lastError = null;
      return objects;
    },
  };

  return provider;
}