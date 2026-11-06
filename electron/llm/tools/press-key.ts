import { performPressKey } from '../../input/engine';
import type { ToolDefinition } from './index';

export const pressKeyTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'press_key',
      description:
        'Send a keyboard shortcut or a single key to the focused window. Examples: "ctrl+n" (new note/file), "ctrl+s" (save), "ctrl+a", "enter", "tab", "escape", "f5", "alt+f4". Modifiers combine with + : ctrl, alt, shift, cmd/meta.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'The key or shortcut combo, e.g. "ctrl+n", "ctrl+shift+s", "enter", "escape".',
          },
          times: {
            type: 'number',
            description: 'Optional number of presses (default 1).',
          },
        },
        required: ['key'],
      },
    },
  },
  uiLabel: (args) => `Pressing ${String(args.key ?? 'key')}`,
  async execute(args) {
    const key = String(args.key ?? '').trim();
    if (!key) return 'Error: press_key requires a "key" argument.';
    const times = Math.min(20, Math.max(1, Math.round(Number(args.times ?? 1)) || 1));
    try {
      await performPressKey(key, times);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return times > 1 ? `Pressed ${key} ${times} times.` : `Pressed ${key}.`;
  },
};
