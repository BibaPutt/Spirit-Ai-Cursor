// Pure cua-driver call planning (Phase 6) — no Electron imports, unit-tested.
// Turns high-level Spirit input actions into the exact MCP `tools/call` the
// vendored driver expects, adapting to whatever subset of tools the driver
// actually exposes (probed at connect time via tools/list). When a driver tool
// is missing, buildDriverCall returns null and the engine falls back to native
// for just that action — no session-wide degradation for absent tools.
//
// Tool/argument names below match the desktop-scope surface the vendored
// cua-driver reports (click, double_click, right_click, drag, type_text,
// press_key, hotkey, scroll, get_cursor_position, ...). Spirit targets the
// desktop scope with screen-absolute coordinates, same convention as the
// click/type_text calls from the earlier engine work.

export type DriverToolName =
  | 'click'
  | 'type_text'
  | 'scroll'
  | 'press_key'
  | 'hotkey'
  | 'drag'
  | 'get_cursor_position';

export type DriverAction =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right'; count: number }
  | { kind: 'type_text'; text: string; delayMs?: number }
  | { kind: 'scroll'; delta: number }
  | { kind: 'press_key'; combo: string; times?: number }
  | { kind: 'drag'; fromX: number; fromY: number; toX: number; toY: number; steps?: number }
  | { kind: 'get_cursor_position' };

export type DriverCall = {
  tool: DriverToolName;
  args: Record<string, unknown>;
  // press_key with modifiers (hotkey path) or a repeat count: the engine loops
  // the whole call this many times, each attempting its own background→
  // foreground escalation.
  repeats?: number;
};

export type DriverToolSet = { has: (tool: string) => boolean };

export const areAllTools = (
  known: readonly string[],
): DriverToolSet => ({ has: (tool) => known.includes(tool) });

const SESSION = 'spirit';
const SCOPE = 'desktop';

// Key-name mapping from Spirit's combo conventions ("ctrl+n", "enter") to the
// driver's press_key/hotkey names. Modifiers use the driver's spellings.
const MODIFIER_MAP: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'win',
  cmd: 'win',
  command: 'win',
  win: 'win',
  super: 'win',
};

const KEY_MAP: Record<string, string> = {
  enter: 'return',
  return: 'return',
  esc: 'escape',
  escape: 'escape',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  tab: 'tab',
  space: 'space',
  delete: 'delete',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
};

const COMBINABLE_KEYS = /^[a-z0-9]$|^f(?:[1-9]|1[0-2])$/;

// Split a keyboard shortcut ("ctrl+shift+s", "enter", "f5") into driver
// modifier + key names. Mirrors actions.ts' parseKeyCombo conventions but emits
// driver spellings instead of uiohook codes.
export function splitCombo(
  combo: string,
): { modifiers: string[]; key: string } | { error: string } {
  const parts = combo
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return { error: 'empty key combo' };
  const modifiers: string[] = [];
  let main = '';
  for (const part of parts) {
    const mod = MODIFIER_MAP[part];
    if (mod) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
      continue;
    }
    if (!main) {
      main = part;
    } else {
      return { error: `too many keys in "${combo}"` };
    }
  }
  if (!main) return { error: `bare modifier "${parts.join('+')}" has no key` };
  const mapped = KEY_MAP[main] ?? main;
  if (!COMBINABLE_KEYS.test(mapped) && !KEY_MAP[main]) {
    return { error: `unknown key "${main}"` };
  }
  return { modifiers, key: mapped };
}

// Which driver tool a press_key action should use, given how its combo parsed.
// Combos with modifiers go through `hotkey` (synchronized combo); bare keys use
// `press_key`. Returns null when the driver doesn't expose the needed tool or
// the combo is unrepresentable.
export function pressKeyCall(
  combo: string,
  times: number,
  acc: DriverToolSet,
  deliveryMode: 'background' | 'foreground',
): DriverCall | null {
  const parsed = splitCombo(combo);
  if ('error' in parsed) return null;
  if (parsed.modifiers.length > 0) {
    if (!acc.has('hotkey')) return null;
    const repeats = Math.max(1, Math.floor(times) || 1);
    return {
      tool: 'hotkey',
      args: {
        session: SESSION,
        scope: SCOPE,
        delivery_mode: deliveryMode,
        keys: [...parsed.modifiers, parsed.key],
      },
      repeats,
    };
  }
  if (!acc.has('press_key')) return null;
  const repeats = Math.max(1, Math.floor(times) || 1);
  return {
    tool: 'press_key',
    args: { session: SESSION, scope: SCOPE, delivery_mode: deliveryMode, key: parsed.key },
    repeats,
  };
}

// Build the MCP call for a high-level action. Returns null when the driver
// doesn't expose the tool that action needs (caller falls back to native).
export function buildDriverCall(
  action: DriverAction,
  acc: DriverToolSet,
  deliveryMode: 'background' | 'foreground' = 'background',
): DriverCall | null {
  switch (action.kind) {
    case 'click': {
      if (!acc.has('click')) return null;
      const count = Math.min(3, Math.max(1, Math.round(action.count) || 1));
      return {
        tool: 'click',
        args: {
          session: SESSION,
          scope: SCOPE,
          delivery_mode: deliveryMode,
          button: action.button === 'right' ? 'right' : 'left',
          count,
          x: Math.round(action.x),
          y: Math.round(action.y),
        },
      };
    }
    case 'type_text': {
      if (!acc.has('type_text')) return null;
      const delayMs = action.delayMs ?? 20;
      return {
        tool: 'type_text',
        args: {
          session: SESSION,
          scope: SCOPE,
          delivery_mode: deliveryMode,
          delay_ms: Math.max(0, Math.min(200, Math.round(delayMs) || 0)),
          text: action.text,
        },
      };
    }
    case 'scroll': {
      if (!acc.has('scroll')) return null;
      const amount = Math.min(50, Math.max(1, Math.abs(Math.round(action.delta)) || 1));
      return {
        tool: 'scroll',
        args: {
          session: SESSION,
          scope: SCOPE,
          delivery_mode: deliveryMode,
          by: 'line',
          direction: action.delta >= 0 ? 'up' : 'down',
          amount,
        },
      };
    }
    case 'press_key':
      return pressKeyCall(action.combo, action.times ?? 1, acc, deliveryMode);
    case 'drag': {
      if (!acc.has('drag')) return null;
      const args: Record<string, unknown> = {
        session: SESSION,
        scope: SCOPE,
        delivery_mode: deliveryMode,
        from_x: Math.round(action.fromX),
        from_y: Math.round(action.fromY),
        to_x: Math.round(action.toX),
        to_y: Math.round(action.toY),
      };
      if (typeof action.steps === 'number' && Number.isFinite(action.steps)) {
        args.steps = Math.min(100, Math.max(1, Math.round(action.steps)));
      }
      return { tool: 'drag', args };
    }
    case 'get_cursor_position': {
      if (!acc.has('get_cursor_position')) return null;
      return { tool: 'get_cursor_position', args: { session: SESSION } };
    }
    default:
      return null;
  }
}