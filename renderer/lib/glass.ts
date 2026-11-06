// Glass panel look — pure calc for the prompt box + CSS-var painter.
// The slider (Settings → Appearance → Window) drives two vars the panel
// class reads (see styles/globals.css `.spirit-glass-panel`):
//   --spirit-glass-alpha  panel background opacity ~0.81 (full milk) … 1 (solid)
//   --spirit-glass-blur   backdrop blur 0 (clear mode) … 19px (full frost)
// Works on every OS including Linux — no native APIs involved.

export type GlassMode = 'clear' | 'glass';

export interface GlassPanel {
  alpha: number;
  blurPx: number;
}

export function clampGlass(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Slider: 0 = solid opaque box (no frost, the old flat look),
// 100 = today's old-25 frost (the sweet spot is now the max — the old
// 0–25 range stretches across the full slider for finer control).
// Higher = milkier + blurrier, never below readable (alpha floor 0.45).
// Default 100.
//
// MILKY FROST (not clear glass): the pane is translucent milk, not tinted
// plastic — the blurred background melts through a bright base. Alpha runs
// 1.0 → ~0.81 across the slider; blur ramps 12→19px alongside it.
export const GLASS_FULL_SCALE = 0.25;
export function glassPanelFor(mode: GlassMode, intensity: number, fade: number): GlassPanel {
  const i = (clampGlass(intensity, 100) / 100) * GLASS_FULL_SCALE;
  const f = clampGlass(fade, 0) / 100;
  const alpha = Math.max(0.45, 1 - 0.75 * i) * (1 - 0.5 * f);
  if (mode === 'clear') {
    return { alpha: Math.round(alpha * 100) / 100, blurPx: 0 };
  }
  return { alpha: Math.round(alpha * 100) / 100, blurPx: Math.round(12 + 28 * i) };
}

export function applyGlassVars(
  root: { style: { setProperty: (k: string, v: string) => void } },
  mode: GlassMode,
  intensity: number,
  fade: number,
): GlassPanel {
  const panel = glassPanelFor(mode, intensity, fade);
  root.style.setProperty('--spirit-glass-alpha', String(panel.alpha));
  root.style.setProperty('--spirit-glass-blur', `${panel.blurPx}px`);
  return panel;
}
