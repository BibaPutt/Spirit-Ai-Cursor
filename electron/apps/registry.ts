// Universal app discovery — replaces the old 7-app hardcoded whitelist.
//
// On every OS we enumerate what is ACTUALLY installed on the user's machine,
// so `launch_app` can open any app by name with zero code changes:
//   - Windows: Start Menu via `Get-StartApps` (covers installed desktop apps
//     AND UWP apps; AUMID entries are launched through shell:AppsFolder).
//   - macOS:   `/Applications`, `/System/Applications`, `~/Applications` for
//     `.app` bundles, launched with `open -a <Name>`.
//   - Linux:   `.desktop` files in `/usr/share/applications` and
//     `~/.local/share/applications`, launched with `gio launch`.
//
// Discovery is cached for a short TTL — the machine's installed set changes
// only on install/uninstall, and re-scanning on every tool call is wasteful.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const execFileP = promisify(execFile);

export type RegistryApp = {
  name: string;
  // How to launch:
  //  'aumid'   Windows UWP / packaged app — `explorer.exe shell:AppsFolder\<id>`
  //  'name'    Windows desktop app — `cmd /c start "" <name>`
  //  'mac'     macOS — `open -a <name>`
  //  'desktop' Linux — `gio launch <path-to-.desktop>`
  kind: 'aumid' | 'name' | 'mac' | 'desktop';
  // Windows AUMID or Linux .desktop path; empty for kind='name'/'mac'.
  ref: string;
};

const CACHE_TTL_MS = 60_000;
let cachedApps: RegistryApp[] | null = null;
let cachedAt = 0;

export async function discoverApps(): Promise<RegistryApp[]> {
  const now = Date.now();
  if (cachedApps && now - cachedAt < CACHE_TTL_MS) return cachedApps;
  let apps: RegistryApp[] = [];
  try {
    if (process.platform === 'win32') {
      apps = await windowsApps();
    } else if (process.platform === 'darwin') {
      apps = macApps();
    } else {
      apps = linuxApps();
    }
  } catch (err) {
    console.warn(
      '[registry] app discovery failed:',
      err instanceof Error ? err.message : err,
    );
    apps = [];
  }
  cachedApps = apps;
  cachedAt = now;
  return apps;
}

// For tests: force a refresh.
export function clearRegistryCache(): void {
  cachedApps = null;
  cachedAt = 0;
}

async function windowsApps(): Promise<RegistryApp[]> {
  try {
    // `Get-StartApps` lists every Start Menu entry: desktop shortcuts AND
    // UWP apps, both as {Name, AppID}. Fast (~200ms), no extra assemblies.
    const { stdout } = await execFileP(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-StartApps | ForEach-Object { $_.Name + "`t" + $_.AppID }',
      ],
      { timeout: 10_000, windowsHide: true },
    );
    const apps: RegistryApp[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const name = line.slice(0, tab).trim();
      const id = line.slice(tab + 1).trim();
      if (!name || !id) continue;
      // AUMID contains a '!' (e.g. "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App").
      // Desktop apps return the target exe / shortcut path as their AppID —
      // keep it so we can launch by absolute path instead of guessing by name
      // (`cmd /c start "" <name>` silently fails for apps with no App Paths).
      const isAumid = id.includes('!');
      const isPath = /^[A-Za-z]:[\\/]/.test(id);
      apps.push(
        isAumid
          ? { name, kind: 'aumid', ref: id }
          : { name, kind: 'name', ref: isPath ? id : '' },
      );
    }
    return apps;
  } catch (err) {
    // Fallback: Start Menu .lnk folders (desktop apps only).
    console.warn('[registry] Get-StartApps failed; scanning Start Menu folders');
    return startMenuShortcuts();
  }
}

function startMenuShortcuts(): RegistryApp[] {
  const dirs = [
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.PROGRAMDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const apps: RegistryApp[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const walk = (d: string): void => {
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.toLowerCase().endsWith('.lnk')) {
          const base = e.name.replace(/\.lnk$/i, '').trim();
          const key = base.toLowerCase();
          if (base && !seen.has(key)) {
            seen.add(key);
            apps.push({ name: base, kind: 'name', ref: '' });
          }
        }
      }
    };
    walk(dir);
  }
  return apps;
}

function macApps(): RegistryApp[] {
  const roots = [
    '/Applications',
    '/System/Applications',
    join(homedir(), 'Applications'),
  ];
  const apps: RegistryApp[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.app')) continue;
      const base = name.replace(/\.app$/i, '').trim();
      if (!base || seen.has(base.toLowerCase())) continue;
      seen.add(base.toLowerCase());
      apps.push({ name: base, kind: 'mac', ref: '' });
    }
  }
  // Sort alphabetically; /Applications before /System/Applications keeps
  // user-installed duplicates first.
  return apps;
}

function linuxApps(): RegistryApp[] {
  const dirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    join(homedir(), '.local', 'share', 'applications'),
  ];
  const apps: RegistryApp[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.desktop')) continue;
      const path = join(dir, name);
      let content = '';
      try {
        content = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      if (!/Type\s*=\s*Application/i.test(content)) continue;
      if (/Hidden\s*=\s*true/i.test(content)) continue;
      const m = content.match(/^\s*Name\s*=\s*(.+)$/m);
      const displayName = m ? m[1].trim() : name.replace(/\.desktop$/i, '');
      const key = displayName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      apps.push({ name: displayName, kind: 'desktop', ref: path });
    }
  }
  return apps;
}

// Fuzzy name search over the discovered set. Returns up to `limit` matches,
// ranked by substring position (starts-with beats contains).
export function searchApps(apps: RegistryApp[], query: string, limit = 10): RegistryApp[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ app: RegistryApp; score: number }> = [];
  for (const app of apps) {
    const name = app.name.toLowerCase();
    let score = -1;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    if (score >= 0) scored.push({ app, score });
  }
  scored.sort((a, b) => a.score - b.score || a.app.name.localeCompare(b.app.name));
  return scored.slice(0, limit).map((s) => s.app);
}

// Launch an app by registry entry. Resolves once the process has spawned —
// never waits for the GUI app to exit.
export async function launchRegistryApp(app: RegistryApp): Promise<void> {
  if (process.platform === 'win32') {
    if (app.kind === 'aumid') {
      await spawnFireAndForget('explorer.exe', ['shell:AppsFolder\\' + app.ref]);
    } else {
      // Prefer the absolute path recorded from Get-StartApps over a name
      // lookup — `start` resolves names via App Paths and silently does
      // nothing when the app is missing from there. Fall back to the name
      // if the recorded path no longer exists.
      const refIsPath = /^[A-Za-z]:[\\/]/.test(app.ref);
      const target = refIsPath && existsSync(app.ref) ? app.ref : app.name;
      await spawnFireAndForget('cmd', ['/c', 'start', '', target]);
    }
    return;
  }
  if (process.platform === 'darwin') {
    await spawnFireAndForget('open', ['-a', app.name]);
    return;
  }
  // Linux
  await spawnFireAndForget('gio', ['launch', app.ref || app.name]);
}

// Best-effort launch by free-form name, with a fallback to the platform's
// generic `start <name>` / `open -a <name>` style invocation when the name
// was not found in the registry.
export async function launchAppByName(
  name: string,
): Promise<{ ok: true; app: string } | { ok: false; error: string }> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: 'No app name given.' };
  const apps = await discoverApps();
  const match = searchApps(apps, clean, 1)[0];
  if (match) {
    try {
      await launchRegistryApp(match);
      return { ok: true, app: match.name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  // Fallback: try the platform's name-based launcher directly.
  try {
    if (process.platform === 'win32') {
      await spawnFireAndForget('cmd', ['/c', 'start', '', clean]);
    } else if (process.platform === 'darwin') {
      await spawnFireAndForget('open', ['-a', clean]);
    } else {
      await spawnFireAndForget('gio', ['launch', clean]);
    }
    return { ok: true, app: clean };
  } catch (err) {
    return {
      ok: false,
      error: `Could not find or launch "${clean}" (${err instanceof Error ? err.message : err}).`,
    };
  }
}

function spawnFireAndForget(
  cmd: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    child.unref();
    child.once('error', (err) => reject(err));
    child.once('spawn', () => resolve());
  });
}
