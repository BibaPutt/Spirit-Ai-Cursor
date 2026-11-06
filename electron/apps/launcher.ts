import type { LaunchableApp } from '../types';
import { focusProcessWindows } from '../input/actions';
import {
  discoverApps,
  launchAppByName,
  launchRegistryApp,
  searchApps,
} from './registry';

// Launcher built on the universal app registry (see ./registry.ts).
//
// `launch_app` is no longer constrained to a hardcoded whitelist — any app
// installed on the machine is discoverable by name. The old 7-entry APPS
// table is gone. App ids for the legacy `launchApp(id)` / `apps:launch` IPC
// are simply registry entry names (lowercased), so nothing on the renderer
// side needs to change.

export type { RegistryApp } from './registry';

// After launching, bring the app's window to the foreground so subsequent
// type_text / press_key land in the app instead of wherever focus was
// (usually Spirit's own overlay). Best-effort — never fails the launch.
// The process name is the registry name without extension.
export async function focusLaunchedApp(appName: string): Promise<void> {
  const names = [appName.replace(/\.exe$/i, '')];
  if (process.platform === 'win32') {
    await focusProcessWindows(names);
  } else if (process.platform === 'linux') {
    await focusProcessWindows(names);
  }
}

export async function listLaunchableApps(): Promise<LaunchableApp[]> {
  const apps = await discoverApps();
  return apps.map((a) => ({ id: a.name, label: a.name, available: true }));
}

// Legacy id-based launch, used by the `apps:launch` IPC and the tray
// shortcuts. Matches by fuzzy name against the live registry, then falls
// back to the platform's name-based launcher.
export async function launchApp(
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'Invalid app name.' };
  }
  const apps = await discoverApps();
  const match = searchApps(apps, name, 1)[0];
  if (match) {
    try {
      await launchRegistryApp(match);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const fallback = await launchAppByName(name);
  return fallback.ok ? { ok: true } : { ok: false, error: fallback.error };
}
