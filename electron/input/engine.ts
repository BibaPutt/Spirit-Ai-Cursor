// Input engine router: native synthesis vs the vendored cua-driver MCP daemon.
//
// The driver's desktop-scope input tools deliver clicks/typing/keypresses/
// scrolling/dragging with zero focus steal — UIA hit-test + PostMessage on
// Windows, with a verified `background_unavailable` escalation to a brief
// foreground + SendInput for targets that drop posted input. The native engine
// (PowerShell + user32, CoreGraphics/osascript, xdotool — see actions.ts)
// remains the fallback.
//
// Coverage (Phase 6): click, type_text, scroll, press_key (bare keys via
// `press_key`, combos via `hotkey`), drag, and the read-only cursor position.
// The driver exposes no real-pointer move — `move_cursor` only moves its own
// agent overlay — so move_mouse stays native. Each action is planned against
// the driver's tools/list discovery set: a driver that lacks a tool falls back
// to native for just that action; a real call/connect failure degrades to
// native for the rest of the session.

import { app, screen } from 'electron';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clickAt as nativeClickAt,
  drag as nativeDrag,
  focusProcessWindows as nativeFocusProcessWindows,
  focusWindowByTitle as nativeFocusWindowByTitle,
  moveMouse as nativeMoveMouse,
  pressKey as nativePressKey,
  readForegroundTitle as nativeReadForegroundTitle,
  releaseOverlayFocus,
  scrollLines as nativeScrollLines,
  typeText as nativeTypeText,
} from './actions';
import { beginForward, endForward } from './forward-tracker';
import { overrideAllOverlaysClickThrough } from '../windows/overlay';
import { onBeforeQuit } from '../lifecycle';
import { CuaDriverError, CuaDriverMcpClient } from './cua-driver-client';
import {
  buildDriverCall,
  type DriverCall,
} from './driver-tool-args';
import {
  cursorFromResult,
  nextDeliveryMode,
  parseVerdict,
  resultText,
  type EngineKind,
} from './engine-decision';

export interface ClickOptions {
  double?: boolean;
  button?: 'left' | 'right';
}

export interface InputEngine {
  readonly kind: EngineKind;
  click(x: number, y: number, opts?: ClickOptions): Promise<void>;
  typeText(text: string): Promise<void>;
  scroll(delta: number): Promise<void>;
  pressKey(combo: string, times?: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number, steps?: number): Promise<void>;
  readCursorPosition(): Promise<{ x: number; y: number } | null>;
  shutdown(): void;
}

// Native engine — pre-existing action.ts implementations.

class NativeEngine implements InputEngine {
  readonly kind: EngineKind = 'native';

  async click(x: number, y: number, opts?: ClickOptions): Promise<void> {
    await nativeClickAt(x, y, opts);
  }

  async typeText(text: string): Promise<void> {
    await nativeTypeText(text);
  }

  async scroll(delta: number): Promise<void> {
    await nativeScrollLines(delta);
  }

  async pressKey(combo: string, times?: number): Promise<void> {
    const result = await nativePressKey(combo, times ?? 1);
    if (result !== 'ok') throw new Error(result);
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, steps?: number): Promise<void> {
    await nativeDrag(fromX, fromY, toX, toY, steps);
  }

  async readCursorPosition(): Promise<{ x: number; y: number } | null> {
    try {
      const p = screen.getCursorScreenPoint();
      return { x: p.x, y: p.y };
    } catch {
      return null;
    }
  }

  shutdown(): void {
    /* nothing to dispose */
  }
}

// Cua Driver engine — desktop-scope MCP input with background→foreground
// escalation and the same overlay click-through accounting the native engine
// uses, so synthesized events never land on Spirit's own overlay and the
// global hook tells driver-posted clicks apart from physical ones.

class CuaDriverInputEngine implements InputEngine {
  readonly kind: EngineKind = 'cua-driver';
  private readonly client: CuaDriverMcpClient;
  // Per-action native fallback for actions the driver doesn't expose (per the
  // tools/list probe) or can't represent (malformed key combos, zero scroll).
  private readonly native = new NativeEngine();
  private typeQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  private constructor(client: CuaDriverMcpClient) {
    this.client = client;
  }

  static async create(exePath: string): Promise<CuaDriverInputEngine | null> {
    const client = new CuaDriverMcpClient({
      exePath,
      onLog: (message) => console.debug(message),
    });
    try {
      await client.connect();
      // End-to-end proof that the driver is usable, then learn its tool set so
      // actions route to native instead of failing when a tool is absent.
      const health = await client.callTool('get_cursor_position', { session: 'spirit' });
      if (health && health.isError === true) {
        client.close();
        return null;
      }
      await client.fetchTools();
      return new CuaDriverInputEngine(client);
    } catch (err) {
      client.close();
      return null;
    }
  }

  private canTool(name: string): boolean {
    return this.client.hasToolSet.has(name);
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    this.assertUsable();
    const call = buildDriverCall({
      kind: 'click',
      x,
      y,
      button: opts.button === 'right' ? 'right' : 'left',
      count: opts.double === true ? 2 : 1,
    }, this.client.hasToolSet);
    if (!call) return this.native.click(x, y, opts);
    const count = call.args.count as number;
    beginForward(count);
    try {
      releaseOverlayFocus();
      await withOverlaysClickThrough(() => this.deliver(call));
    } finally {
      endForward();
    }
  }

  async typeText(text: string): Promise<void> {
    this.assertUsable();
    // Long or non-ASCII text goes native (clipboard paste): the driver's
    // key-event synthesis drops characters past a few hundred and mangles
    // emoji (observed: 1048-char letter arrived as "My " + garbage). Paste
    // is atomic — every character and line break lands intact.
    if (text.length > 200 || /[^\x00-\x7F]/.test(text)) {
      return this.native.typeText(text);
    }
    const call = buildDriverCall({ kind: 'type_text', text }, this.client.hasToolSet);
    if (!call) return this.native.typeText(text);
    const task = this.typeQueue.then(() => {
      releaseOverlayFocus();
      return withOverlaysClickThrough(() => this.deliver(call));
    });
    this.typeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async scroll(delta: number): Promise<void> {
    this.assertUsable();
    if (Math.round(delta) === 0) return;
    const call = buildDriverCall({ kind: 'scroll', delta }, this.client.hasToolSet);
    if (!call) return this.native.scroll(delta);
    await this.deliver(call);
  }

  async pressKey(combo: string, times?: number): Promise<void> {
    this.assertUsable();
    const call = buildDriverCall({ kind: 'press_key', combo, times }, this.client.hasToolSet);
    if (!call) return this.native.pressKey(combo, times);
    await this.deliver(call);
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps?: number,
  ): Promise<void> {
    this.assertUsable();
    const call = buildDriverCall(
      { kind: 'drag', fromX, fromY, toX, toY, steps },
      this.client.hasToolSet,
    );
    if (!call) return this.native.drag(fromX, fromY, toX, toY, steps);
    releaseOverlayFocus();
    await withOverlaysClickThrough(() => this.deliver(call));
  }

  async readCursorPosition(): Promise<{ x: number; y: number } | null> {
    // Read-only + best-effort: a driver failure here never degrades the
    // session — it just falls back to the native position read.
    const call = buildDriverCall({ kind: 'get_cursor_position' }, this.client.hasToolSet);
    if (call && !this.disposed && this.client.isReady) {
      try {
        const result = await this.client.callTool('get_cursor_position', call.args);
        const point = cursorFromResult(result as never);
        if (point) return point;
      } catch {
        /* fall through to native */
      }
    }
    return this.native.readCursorPosition();
  }

  // Deliver one planned call with background→foreground escalation and, for
  // press_key, multi-press repeats (each press escalates independently).
  // The driver's structured verdict ({effect, escalation, code}) drives the
  // retry: confirmed = done, unverifiable = caller must recapture, and a
  // foreground escalation is retried once — never looped.
  private async deliver(call: DriverCall): Promise<void> {
    const repeats = call.repeats ?? 1;
    for (let i = 0; i < repeats; i++) {
      let result = await this.client.callTool(call.tool, call.args);
      const verdict = parseVerdict(result);
      if (verdict.effect !== 'unknown' || verdict.code) {
        console.debug(
          `[cua-driver] ${call.tool} verdict effect=${verdict.effect} ` +
            `escalation=${verdict.escalation ?? 'none'} code=${verdict.code ?? 'none'} ` +
            `verified=${verdict.verified}`,
        );
      }
      const next = nextDeliveryMode(0, result);
      if (next === 'foreground') {
        result = await this.client.callTool(call.tool, { ...call.args, delivery_mode: 'foreground' });
      }
      if (result && result.isError === true) {
        const retryVerdict = parseVerdict(result);
        const code = retryVerdict.code ? ` [${retryVerdict.code}]` : '';
        throw new CuaDriverError(`${call.tool} failed${code}: ${resultText(result)}`);
      }
    }
  }

  private assertUsable(): void {
    if (this.disposed || this.client.isClosed || !this.client.isReady) {
      throw new CuaDriverError('cua-driver engine is not usable');
    }
  }

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client.close();
  }
}

async function withOverlaysClickThrough<T>(fn: () => Promise<T>): Promise<T> {
  overrideAllOverlaysClickThrough(true);
  try {
    return await fn();
  } finally {
    overrideAllOverlaysClickThrough(false);
  }
}

// Engine selection + session-stable fallback.

function driverExePath(): string {
  const override = process.env.SPIRIT_CUA_DRIVER_PATH;
  if (override) return override;
  if (app.isPackaged) return join(process.resourcesPath, 'bin', 'cua-driver.exe');
  return join(app.getAppPath(), 'resources', 'bin', 'cua-driver.exe');
}

let enginePromise: Promise<InputEngine> | null = null;

async function createEngine(): Promise<InputEngine> {
  if (process.env.SPIRIT_CUA_DRIVER === '0') return new NativeEngine();

  const exePath = driverExePath();
  let binaryFound = false;
  try {
    await access(exePath);
    binaryFound = true;
  } catch {
    binaryFound = false;
  }

  if (binaryFound) {
    try {
      const driver = await CuaDriverInputEngine.create(exePath);
      if (driver) return driver;
    } catch {
      /* fall through to native */
    }
  }
  return new NativeEngine();
}

export function getInputEngine(): Promise<InputEngine> {
  if (!enginePromise) {
    enginePromise = createEngine();
    enginePromise.then((engine) => {
      if (engine.kind === 'cua-driver') {
        onBeforeQuit(() => {
          engine.shutdown();
        });
      }
    });
  }
  return enginePromise;
}

async function degradeToNative(failed: InputEngine): Promise<void> {
  try {
    failed.shutdown();
  } catch {
    /* ignore */
  }
  enginePromise = Promise.resolve(new NativeEngine());
}

// Run one input action against the current engine; a driver failure degrades
// to native for the rest of the session and the action is retried once there.
// Native failures propagate (they were the previous behavior).
async function runWithInputFallback(run: (engine: InputEngine) => Promise<void>): Promise<void> {
  const engine = await getInputEngine();
  try {
    await run(engine);
  } catch (err) {
    if (engine.kind === 'cua-driver') {
      await degradeToNative(engine);
      await run(await getInputEngine());
    } else {
      throw err;
    }
  }
}

// Session-stable input entry points (Phase 3b + Phase 6). LLM tools call these
// — never actions.ts directly.
export async function performClick(x: number, y: number, opts?: ClickOptions): Promise<void> {
  await runWithInputFallback((engine) => engine.click(x, y, opts));
}

export async function performType(text: string): Promise<void> {
  // Focus drift guard: typing right after a focus_window swap can land in
  // the wrong app if the OS hasn't caught up or something stole focus
  // (observed: focus said Notepad, text went nowhere). If we focused
  // something <30s ago and the foreground no longer matches, re-focus once.
  // Unreadable foreground never blocks — best effort only.
  const ask = lastFocusAsk;
  if (ask && Date.now() - ask.at < 30_000) {
    try {
      const fg = await nativeReadForegroundTitle().catch(() => null);
      if (fg && !focusMatches(fg, ask)) {
        console.warn(`[input] focus drifted to "${fg}" — re-focusing before typing`);
        await performFocusWindow({ names: ask.names, title: ask.title });
      }
    } catch {
      /* best-effort */
    }
  }
  await runWithInputFallback((engine) => engine.typeText(text));
}

export async function performScroll(delta: number): Promise<void> {
  await runWithInputFallback((engine) => engine.scroll(delta));
}

export async function performPressKey(combo: string, times?: number): Promise<void> {
  await runWithInputFallback((engine) => engine.pressKey(combo, times));
}

export async function performDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps?: number,
): Promise<void> {
  await runWithInputFallback((engine) => engine.drag(fromX, fromY, toX, toY, steps));
}

// Read-only: returns the current cursor position (driver-owned read when the
// driver is healthy, native screen query otherwise). Never degrades.
export async function performReadCursorPosition(): Promise<{ x: number; y: number } | null> {
  try {
    return await (await getInputEngine()).readCursorPosition();
  } catch {
    return null;
  }
}

// The driver's move_cursor only moves its own agent overlay (never the real
// pointer), so mouse movement stays native in both engines. Exposed through
// perform* so tools don't import actions.ts directly.
export async function performMoveMouse(x: number, y: number): Promise<void> {
  await nativeMoveMouse(x, y);
}

// Window-focus stays native in both engines — the driver's bring_to_front is a
// persistent focus-proxy for RDP-style sessions, not the foreground swap the
// agentic loop wants when the user asked it to drive an app. Best-effort:
// returns whether a target window was found and brought up.
export async function performFocusWindow(opts: {
  names?: string[];
  title?: string;
}): Promise<boolean> {
  try {
    const ok = opts.title?.trim()
      ? await nativeFocusWindowByTitle(opts.title.trim())
      : await nativeFocusProcessWindows(opts.names ?? []);
    if (ok) lastFocusAsk = { names: opts.names, title: opts.title, at: Date.now() };
    return ok;
  } catch {
    return false;
  }
}

// Last window the agent deliberately focused (see performFocusWindow).
// performType consults it for the drift guard above.
let lastFocusAsk: { names?: string[]; title?: string; at: number } | null = null;

function focusMatches(title: string, ask: { names?: string[]; title?: string }): boolean {
  const t = title.toLowerCase();
  if (ask.title?.trim() && t.includes(ask.title.trim().toLowerCase())) return true;
  for (const n of ask.names ?? []) {
    const needle = n.trim().toLowerCase().replace(/\.exe$/, '');
    if (needle && t.includes(needle)) return true;
  }
  return false;
}

// Title of the current foreground window — lets tools verify a focus landed
// and report where type_text actually typed. Read-only, never degrades.
export async function performReadForegroundTitle(): Promise<string | null> {
  try {
    return await nativeReadForegroundTitle();
  } catch {
    return null;
  }
}