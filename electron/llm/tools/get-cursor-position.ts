import { performReadCursorPosition } from '../../input/engine';
import type { ToolDefinition } from './index';

// `get_cursor_position` is a read-only companion to click/move_mouse: the
// model can confirm where the pointer actually is without its own tracking
// breaking down (e.g. after the user physically moved it). Read-only → no
// approval required. Uses the driver's native read when the driver is healthy,
// otherwise the OS cursor query.

export const getCursorPositionTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'get_cursor_position',
      description:
        'Get the current mouse position as absolute screen coordinates (x, y in pixels, primary monitor origin at top-left). Use to verify where the pointer is before clicking or after the user may have moved it.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  uiLabel: () => 'Reading cursor position',
  async execute() {
    try {
      const point = await performReadCursorPosition();
      if (!point) return 'Error: could not read the cursor position.';
      return `Mouse is at (${point.x}, ${point.y}).`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};