import type { SpiritAPI } from '../../electron/types';

function getApi(): SpiritAPI {
  if (typeof window === 'undefined' || !window.spirit) {
    throw new Error('window.spirit is not available. Preload script did not load.');
  }
  return window.spirit;
}

export const ipc = new Proxy<SpiritAPI>({} as SpiritAPI, {
  get(_t, prop: keyof SpiritAPI) {
    return getApi()[prop];
  },
});
