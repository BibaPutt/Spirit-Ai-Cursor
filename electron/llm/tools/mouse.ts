import { performClick, performMoveMouse, performScroll } from '../../input/engine';
import type { ToolDefinition } from './index';

// Weak models sometimes return tool args as a single mangled `_raw` string
// (the providers fall back to { _raw: "<raw arguments text>" } when the
// JSON parse fails) — e.g. '{"button": "left, "x": 589, "y": 450"...'. Without
// salvage the click silently degrades to (0, 0). Pull x/y out of the raw
// text with a targeted regex so the intended point is used.
function resolveCoord(args: Record<string, unknown>, key: 'x' | 'y'): number | null {
  const direct = Number(args[key]);
  if (Number.isFinite(direct)) return Math.round(direct);
  const raw = typeof args._raw === 'string' ? args._raw : '';
  if (raw) {
    const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
    const m = raw.match(re);
    if (m) return Math.round(Number(m[1]));
  }
  return null;
}

function resolvePoint(args: Record<string, unknown>): { x: number; y: number } | null {
  const x = resolveCoord(args, 'x');
  const y = resolveCoord(args, 'y');
  if (x === null || y === null) return null;
  return { x, y };
}

const NO_POINT = 'Error: missing or invalid x,y coordinates for this action.';

export const clickTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'click',
      description:
        'Move the mouse to absolute screen coordinates (x, y in pixels, primary monitor origin at top-left) and click. Use for clicking buttons, links and icons on screen.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Absolute horizontal screen coordinate (pixels).' },
          y: { type: 'number', description: 'Absolute vertical screen coordinate (pixels).' },
          button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button (default left).' },
        },
        required: ['x', 'y'],
      },
    },
  },
  uiLabel: (args) => {
    const p = resolvePoint(args);
    return p ? `Clicking (${p.x}, ${p.y})` : 'Clicking (unknown position)';
  },
  async execute(args) {
    const p = resolvePoint(args);
    if (!p) return NO_POINT;
    await performClick(p.x, p.y, { button: args.button === 'right' ? 'right' : 'left' });
    return `Clicked at (${p.x}, ${p.y}).`;
  },
};

export const doubleClickTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'double_click',
      description:
        'Double-click at absolute screen coordinates (x, y in pixels). Use for opening icons, folders and desktop items.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Absolute horizontal screen coordinate (pixels).' },
          y: { type: 'number', description: 'Absolute vertical screen coordinate (pixels).' },
        },
        required: ['x', 'y'],
      },
    },
  },
  uiLabel: (args) => {
    const p = resolvePoint(args);
    return p ? `Double-clicking (${p.x}, ${p.y})` : 'Double-clicking (unknown position)';
  },
  async execute(args) {
    const p = resolvePoint(args);
    if (!p) return NO_POINT;
    await performClick(p.x, p.y, { double: true });
    return `Double-clicked at (${p.x}, ${p.y}).`;
  },
};

export const moveMouseTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'move_mouse',
      description:
        'Move the mouse to absolute screen coordinates (x, y in pixels) without clicking. Use to hover over an element before a follow-up click.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Absolute horizontal screen coordinate (pixels).' },
          y: { type: 'number', description: 'Absolute vertical screen coordinate (pixels).' },
        },
        required: ['x', 'y'],
      },
    },
  },
  uiLabel: (args) => {
    const p = resolvePoint(args);
    return p ? `Moving mouse to (${p.x}, ${p.y})` : 'Moving mouse (unknown position)';
  },
  async execute(args) {
    const p = resolvePoint(args);
    if (!p) return NO_POINT;
    await performMoveMouse(p.x, p.y);
    return `Moved mouse to (${p.x}, ${p.y}).`;
  },
};

export const scrollTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'scroll',
      description:
        'Scroll the focused window. Positive delta scrolls up, negative scrolls down.',
      parameters: {
        type: 'object',
        properties: {
          delta: {
            type: 'number',
            description: 'Wheel notches to scroll. Positive = up, negative = down.',
          },
        },
        required: ['delta'],
      },
    },
  },
  uiLabel: (args) => {
    const d = Number(args.delta ?? 0);
    return d >= 0 ? `Scrolling up` : `Scrolling down`;
  },
  async execute(args) {
    const delta = Math.min(20, Math.max(-20, Math.round(Number(args.delta ?? 0)) || 0));
    if (delta === 0) return 'No scroll: delta of 0.';
    await performScroll(delta);
    return `Scrolled ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta)} notch(es).`;
  },
};
