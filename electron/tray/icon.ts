import { app, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeImage } from 'electron';

// Icons are static assets baked once during development and committed under
// assets/. Reading a pre-rendered PNG via Electron's built-in nativeImage
// avoids the sharp/libvips native binding that used to break Windows/Linux
// packaging.
//
// Files this module expects in assets/:
//   - icon.png                   (1024x1024, app icon; also the colored tray
//                                 icon on Windows/Linux)
//   - tray-icon-Template.png     (22x22, monochrome macOS template)
//   - tray-icon-Template@2x.png  (44x44 retina macOS template)

let cachedTrayImage: NativeImage | null = null;
let cachedAppIconPath: string | null = null;

// Try the standard candidate paths for an asset file. In dev (vite-plugin-
// electron) main runs out of dist-electron/, so assets/ is one level up.
// In a packaged build assets/ is alongside the app bundle root and
// app.getAppPath() points there. We probe both so the same code works in
// every mode.
function findAsset(name: string): string | null {
  const candidates = [
    join(app.getAppPath(), 'assets', name),
    join(__dirname, '..', 'assets', name),
    join(__dirname, '..', '..', 'assets', name),
    join(__dirname, '..', 'dist', name),
    join(app.getAppPath(), 'dist', name),
    join(process.resourcesPath ?? '', 'assets', name),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* permission denied, etc. */
    }
  }
  return null;
}

function loadTemplateTrayIcon(): NativeImage {
  const path22 = findAsset('tray-icon-Template.png');
  const path44 = findAsset('tray-icon-Template@2x.png');
  if (!path22) {
    console.warn('[icon] tray-icon-Template.png missing in assets/');
    return nativeImage.createEmpty();
  }
  const image = nativeImage.createFromPath(path22);
  if (path44) {
    try {
      const retina = nativeImage.createFromPath(path44);
      if (!retina.isEmpty()) {
        image.addRepresentation({
          scaleFactor: 2.0,
          width: 44,
          height: 44,
          buffer: retina.toPNG(),
        });
      }
    } catch (err) {
      console.warn('[icon] tray @2x add-rep failed:', err);
    }
  }
  // macOS draws template images in the menubar tint and auto-inverts them.
  image.setTemplateImage(true);
  return image;
}

export async function getTrayIcon(): Promise<NativeImage> {
  if (cachedTrayImage) return cachedTrayImage;

  if (process.platform === 'darwin') {
    cachedTrayImage = loadTemplateTrayIcon();
    return cachedTrayImage;
  }

  const appIcon = findAsset('icon.png');
  if (!appIcon) {
    console.warn('[icon] icon.png missing in assets/');
    cachedTrayImage = nativeImage.createEmpty();
    return cachedTrayImage;
  }
  const source = nativeImage.createFromPath(appIcon);
  if (source.isEmpty()) {
    console.warn('[icon] icon.png could not be decoded');
    cachedTrayImage = nativeImage.createEmpty();
    return cachedTrayImage;
  }

  // Windows tray uses 16px at 100% and up to 32px at 200% DPI; Linux panels
  // are typically 22px. Give Electron a clean downscaled source instead of a
  // 1024px app icon.
  const size = process.platform === 'win32' ? 32 : 22;
  cachedTrayImage = source.resize({ width: size, height: size, quality: 'best' });
  cachedTrayImage.setTemplateImage(false);
  return cachedTrayImage;
}

export function getAppIconPathSync(): string {
  if (cachedAppIconPath) return cachedAppIconPath;
  const found = findAsset('icon.png');
  if (!found) {
    console.warn('[icon] icon.png missing in assets/ or dist/');
    return '';
  }
  cachedAppIconPath = found;
  return found;
}

export async function getAppIconPath(): Promise<string> {
  return getAppIconPathSync();
}
