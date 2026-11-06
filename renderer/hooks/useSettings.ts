import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../lib/ipc';
import { applyGlassVars } from '../lib/glass';
import type { Settings } from '../../electron/types';

// Apply runtime CSS toggles derived from settings. Cheap; runs whenever a
// fresh settings snapshot arrives. The reduced-transparency switch toggles
// the glassmorphism alpha vars in globals.css; the glass slider paints the
// panel alpha/blur vars (missing fields = pre-v4 settings → Hermes defaults).
function applyRuntimeCSSFlags(s: Settings | null): void {
  if (!s) return;
  const root = document.documentElement;
  root.dataset.reducedTransparency = s.reducedTransparency ? 'true' : 'false';
  applyGlassVars(
    root,
    s.glassMode === 'clear' ? 'clear' : 'glass',
    typeof s.glassIntensity === 'number' ? s.glassIntensity : 50,
    typeof s.glassFade === 'number' ? s.glassFade : 0,
  );
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await ipc.getSettings();
      setSettings(s);
      applyRuntimeCSSFlags(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async (patch: Partial<Settings>) => {
    const next = await ipc.setSettings(patch);
    setSettings(next);
    applyRuntimeCSSFlags(next);
    return next;
  }, []);

  return { settings, loading, save, refresh };
}
