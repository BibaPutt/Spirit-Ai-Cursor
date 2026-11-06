// Tiny before-quit registry. Long-lived resources (the persistent PowerShell
// worker) register a disposer here; main.ts calls runBeforeQuitHandlers() from
// its existing app.on('before-quit') so nothing leaks across process exit.

type BeforeQuitHandler = () => void;

const handlers: BeforeQuitHandler[] = [];

export function onBeforeQuit(handler: BeforeQuitHandler): void {
  handlers.push(handler);
}

export function runBeforeQuitHandlers(): void {
  // Copy the array first so a handler that registers/unregisters others
  // during teardown cannot extend the iteration.
  for (const handler of [...handlers]) {
    try {
      handler();
    } catch (err) {
      console.warn('[lifecycle] before-quit handler threw:', err);
    }
  }
  handlers.length = 0;
}
