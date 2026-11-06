// Glass look (Hermes-style translucency) — pure math only.
// The panel is painted by the renderer via CSS vars (see
// renderer/lib/glass.ts + `.spirit-glass-panel`): box-only, every OS.
// NOTE: never apply native vibrancy/material/opacity to overlay windows —
// they are fullscreen transparent, so a window-level effect would blur the
// whole screen instead of the prompt box. This module must stay DOM- and
// Electron-free so it unit-tests in plain Node.

import { release } from 'node:os';

export type GlassMode = 'clear' | 'glass';
export type GlassMaterial = 'under-window' | 'popover' | 'titlebar' | 'header';
export type GlassScope = 'window' | 'sidebar';

export interface GlassSettings {
  glassMode: GlassMode;
  glassIntensity: number;
  glassFade: number;
  glassMaterial: GlassMaterial;
  glassScope: GlassScope;
}

export const GLASS_DEFAULTS: GlassSettings = {
  glassMode: 'glass',
  glassIntensity: 100,
  glassFade: 0,
  glassMaterial: 'under-window',
  glassScope: 'sidebar',
};

export function clampGlass(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Clear-mode window opacity: whole window (text included) fades.
// opacity = 1 - 0.7*(i/100)^2, floor 0.3 at 100, 1.0 at 0.
export function windowOpacityFor(mode: GlassMode, intensity: number): number {
  const i = clampGlass(intensity, GLASS_DEFAULTS.glassIntensity) / 100;
  if (mode !== 'clear') return 1;
  return Math.max(0.3, 1 - 0.7 * i * i);
}

// Glass-mode surface: how much native tint the renderer keeps.
// Same 0.25 rescale as the renderer frost math (slider 100 = old-25 look),
// so both paths agree: keep = 100 - effective intensity.
export function glassSurfaceKeep(intensity: number): number {
  return 100 - clampGlass(intensity, GLASS_DEFAULTS.glassIntensity) * 0.25;
}

// Native material supported at all on this platform.
export function glassSupportedOn(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

// Windows needs 22H2+ (build >= 22621) for setBackgroundMaterial.
export function windowsMaterialSupported(
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): boolean {
  if (platform !== 'win32') return false;
  const build = Number((osRelease.split('.').pop() ?? '').trim());
  return Number.isFinite(build) && build >= 22621;
}

// macOS vibrancy name per material (Electron setVibrancy).
export function vibrancyFor(material: GlassMaterial): string {
  switch (material) {
    case 'popover':
      return 'popover';
    case 'titlebar':
      return 'titlebar';
    case 'header':
      return 'header';
    case 'under-window':
    default:
      return 'under-window';
  }
}

// Windows backgroundMaterial name per material.
export function backgroundMaterialFor(material: GlassMaterial): 'acrylic' | 'tabbed' | 'mica' {
  switch (material) {
    case 'under-window':
      return 'acrylic';
    case 'popover':
      return 'tabbed';
    case 'titlebar':
    case 'header':
    default:
      return 'mica';
  }
}

export interface ResolvedGlass {
  mode: GlassMode;
  opacity: number;
  surfaceKeep: number;
  // Null = no native material (CSS-only). Never force clear-mode opacity
  // semantics onto glass mode.
  nativeMaterial: string | null;
}

// Resolve settings → what to apply on this OS. Old Windows and Linux fall
// back to clear-mode math (opacity) so the slider still does something.
export function resolveGlass(
  settings: Partial<GlassSettings>,
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release(),
): ResolvedGlass {
  const mode = settings.glassMode === 'clear' ? 'clear' : 'glass';
  const intensity = clampGlass(settings.glassIntensity, GLASS_DEFAULTS.glassIntensity);
  const material = settings.glassMaterial ?? GLASS_DEFAULTS.glassMaterial;
  if (mode === 'clear' || !glassSupportedOn(platform)) {
    return {
      mode: 'clear',
      opacity: windowOpacityFor('clear', intensity),
      surfaceKeep: glassSurfaceKeep(intensity),
      nativeMaterial: null,
    };
  }
  if (platform === 'darwin') {
    return { mode, opacity: 1, surfaceKeep: glassSurfaceKeep(intensity), nativeMaterial: vibrancyFor(material) };
  }
  if (windowsMaterialSupported(platform, osRelease)) {
    return {
      mode,
      opacity: 1,
      surfaceKeep: glassSurfaceKeep(intensity),
      nativeMaterial: backgroundMaterialFor(material),
    };
  }
  return {
    mode: 'clear',
    opacity: windowOpacityFor('clear', intensity),
    surfaceKeep: glassSurfaceKeep(intensity),
    nativeMaterial: null,
  };
}
