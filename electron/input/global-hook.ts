import { uIOhook } from 'uiohook-napi';

let started = false;

export function startGlobalHook(): boolean {
  if (started) return true;
  try {
    uIOhook.start();
    started = true;
    return true;
  } catch (err) {
    console.error('[global-hook] failed to start uIOhook', err);
    return false;
  }
}

export function stopGlobalHook(): void {
  if (!started) return;
  try {
    uIOhook.stop();
  } catch (err) {
    console.error('[global-hook] error stopping uIOhook', err);
  }
  started = false;
}

export function isGlobalHookStarted(): boolean {
  return started;
}
