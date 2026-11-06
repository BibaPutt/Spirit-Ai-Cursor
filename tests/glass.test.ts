import { describe, expect, it } from 'vitest';
import {
  backgroundMaterialFor,
  glassSupportedOn,
  glassSurfaceKeep,
  resolveGlass,
  vibrancyFor,
  windowOpacityFor,
  windowsMaterialSupported,
} from '../electron/windows/glass';
import { applyGlassVars, glassPanelFor } from '../renderer/lib/glass';

describe('windowOpacityFor (clear mode)', () => {
  it('is opaque at 0 and floors at 0.3', () => {
    expect(windowOpacityFor('clear', 0)).toBe(1);
    expect(windowOpacityFor('clear', 100)).toBeCloseTo(0.3);
  });

  it('matches Hermes default 29 → ~0.94', () => {
    expect(windowOpacityFor('clear', 29)).toBeCloseTo(0.941, 2);
  });

  it('glass mode never touches window opacity', () => {
    expect(windowOpacityFor('glass', 100)).toBe(1);
  });
});

describe('glassSurfaceKeep', () => {
  it('keeps 100 - rescaled intensity (slider 100 = old-25 look)', () => {
    expect(glassSurfaceKeep(100)).toBe(75);
    expect(glassSurfaceKeep(0)).toBe(100);
  });
});

describe('platform gating', () => {
  it('supports native material on mac/win only', () => {
    expect(glassSupportedOn('darwin')).toBe(true);
    expect(glassSupportedOn('win32')).toBe(true);
    expect(glassSupportedOn('linux')).toBe(false);
  });

  it('needs Win11 22H2+ (build 22621)', () => {
    expect(windowsMaterialSupported('win32', '10.0.22621')).toBe(true);
    expect(windowsMaterialSupported('win32', '10.0.19045')).toBe(false);
    expect(windowsMaterialSupported('darwin', '10.0.22621')).toBe(false);
  });

  it('maps materials per platform', () => {
    expect(vibrancyFor('under-window')).toBe('under-window');
    expect(backgroundMaterialFor('under-window')).toBe('acrylic');
    expect(backgroundMaterialFor('popover')).toBe('tabbed');
    expect(backgroundMaterialFor('header')).toBe('mica');
  });
});

describe('resolveGlass', () => {
  it('uses vibrancy on macOS', () => {
    const r = resolveGlass({ glassMode: 'glass', glassIntensity: 29 }, 'darwin', '');
    expect(r).toMatchObject({ mode: 'glass', opacity: 1, nativeMaterial: 'under-window' });
  });

  it('falls back to clear math on Linux and old Windows', () => {
    const linux = resolveGlass({ glassMode: 'glass', glassIntensity: 29 }, 'linux', '');
    expect(linux.mode).toBe('clear');
    expect(linux.nativeMaterial).toBeNull();
    const win10 = resolveGlass({ glassMode: 'glass', glassIntensity: 29 }, 'win32', '10.0.19045');
    expect(win10.mode).toBe('clear');
  });
});

describe('glassPanelFor (renderer)', () => {
  it('0 = solid, 100 = old-25 frost', () => {
    expect(glassPanelFor('glass', 0, 0)).toEqual({ alpha: 1, blurPx: 12 });
    expect(glassPanelFor('glass', 100, 0)).toEqual({ alpha: 0.81, blurPx: 19 });
  });

  it('mid slider → light milk', () => {
    expect(glassPanelFor('glass', 50, 0)).toEqual({ alpha: 0.91, blurPx: 16 });
  });

  it('stays readable at max milk (alpha floor)', () => {
    const p = glassPanelFor('glass', 100, 0);
    expect(p.blurPx).toBe(19);
    expect(p.alpha).toBeGreaterThanOrEqual(0.45);
  });

  it('clear mode has no blur', () => {
    const p = glassPanelFor('clear', 50, 0);
    expect(p.blurPx).toBe(0);
    expect(p.alpha).toBeCloseTo(0.91, 2);
  });
});

describe('applyGlassVars', () => {
  it('paints alpha + blur vars', () => {
    const props: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => { props[k] = v; } } };
    const panel = applyGlassVars(root, 'glass', 29, 0);
    expect(props['--spirit-glass-alpha']).toBe(String(panel.alpha));
    expect(props['--spirit-glass-blur']).toBe('14px');
  });
});
