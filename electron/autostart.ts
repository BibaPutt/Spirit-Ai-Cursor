import { app } from 'electron';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AutostartState } from './types';

// Cross-platform autostart helper. macOS and Windows use Electron's
// built-in `app.setLoginItemSettings`. Linux is handled by writing /
// removing a `.desktop` file in `~/.config/autostart/`.
//
// Source of truth: the OS. We never trust a mirrored "autostart"
// boolean in the store, because the user can revoke login items via
// System Settings without our knowing. Settings UI calls getAutostart()
// fresh every render.
//
// The `--hidden` flag in argv is read at process start by main.ts to
// decide whether to skip showing the main window. Spirit's overlay
// is `show: false` by default, so practically `--hidden` is a no-op for
// the visible UI — but we still record it so the user's intent is
// preserved across launches.

const HIDDEN_FLAG = '--hidden';

function linuxAutostartPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return join(home, '.config', 'autostart', 'spirit.desktop');
}

function linuxDesktopBody(hidden: boolean): string {
  const exe = process.execPath;
  const args = hidden ? ` ${HIDDEN_FLAG}` : '';
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Spirit',
    `Exec=${exe}${args}`,
    'Hidden=false',
    'NoDisplay=false',
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n');
}

export function getAutostart(): AutostartState {
  if (process.platform === 'linux') {
    const exists = existsSync(linuxAutostartPath());
    // We can't cheaply detect the --hidden flag without reading the file;
    // for simplicity we always report `openAsHidden` based on file content
    // when present.
    if (exists) {
      let hidden = false;
      try {
        const fs = require('node:fs') as typeof import('node:fs');
        const body = fs.readFileSync(linuxAutostartPath(), 'utf-8');
        hidden = body.includes(HIDDEN_FLAG);
      } catch {
        /* ignore */
      }
      return { openAtLogin: true, openAsHidden: hidden };
    }
    return { openAtLogin: false, openAsHidden: false };
  }
  const settings = app.getLoginItemSettings();
  return {
    openAtLogin: !!settings.openAtLogin,
    openAsHidden: !!settings.openAsHidden,
  };
}

export function setAutostart(state: AutostartState): AutostartState {
  if (process.platform === 'linux') {
    const path = linuxAutostartPath();
    if (state.openAtLogin) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, linuxDesktopBody(state.openAsHidden), { mode: 0o644 });
      } catch (err) {
        console.warn('[autostart] could not write .desktop file:', err);
      }
    } else if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (err) {
        console.warn('[autostart] could not remove .desktop file:', err);
      }
    }
    return getAutostart();
  }
  app.setLoginItemSettings({
    openAtLogin: state.openAtLogin,
    openAsHidden: process.platform === 'darwin' ? state.openAsHidden : undefined,
    args: state.openAsHidden ? [HIDDEN_FLAG] : [],
  });
  return getAutostart();
}

export function isLaunchedHidden(): boolean {
  return process.argv.includes(HIDDEN_FLAG);
}
