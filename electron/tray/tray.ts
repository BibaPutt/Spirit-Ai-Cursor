import { Menu, Tray, app } from 'electron';
import { getTrayIcon } from './icon';
import { broadcastSettingsOpen, triggerAIModeFromMenu } from '../ipc/handlers';
import { showAboutWindow } from '../windows/about';
import { showLegalWindow, type LegalSection } from '../windows/legal';

let tray: Tray | null = null;
let creating: Promise<void> | null = null;

export async function createTray(): Promise<void> {
  if (tray) return;
  if (creating) return creating;
  creating = (async () => {
    const icon = await getTrayIcon();
    if (tray) return;
    tray = new Tray(icon);
    tray.setToolTip('Spirit');
    rebuildMenu();
  })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export function rebuildMenu(): void {
  if (!tray) return;

  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Open Overlay',
      accelerator: 'CmdOrCtrl+Shift+A',
      click: () => triggerAIModeFromMenu(),
    },
    {
      label: 'Preferences',
      click: () => broadcastSettingsOpen(),
    },
    { type: 'separator' },
    {
      label: 'About Spirit',
      click: () => void showAboutWindow(),
    },
    {
      label: 'Terms of Service',
      click: () => void showLegalWindow('terms' satisfies LegalSection),
    },
    {
      label: 'Privacy Policy',
      click: () => void showLegalWindow('privacy' satisfies LegalSection),
    },
    {
      label: 'Credits & License',
      click: () => void showLegalWindow('credits' satisfies LegalSection),
    },
    { type: 'separator' },
    {
      label: `Spirit v${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      accelerator: 'CmdOrCtrl+Q',
      click: () => app.quit(),
    },
  ];

  const menu = Menu.buildFromTemplate(items);
  tray.setContextMenu(menu);
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
