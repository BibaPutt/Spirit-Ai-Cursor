import { buildScene, resolveElementById } from '../../capture/scene';
import { rememberSceneElements } from '../scene-cache';
import { performDrag } from '../../input/engine';
import type { ToolDefinition } from './index';

// `drag` presses the mouse at one point, moves through interpolated steps to
// another, and releases — for moving files/folders, selecting a text range,
// resizing panels, or drag-and-drop. Coordinates are absolute screen pixels
// (same space as click/move_mouse); alternatively pass element ids from
// ui_read (from_id / to_id) and the app resolves their centers.

export const dragTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'drag',
      description:
        'Drag the mouse from one point to another (press, move, release) — for moving files, selecting a range of text, resizing, or drag-and-drop. Pass absolute screen pixels: drag(from_x, from_y, to_x, to_y). Or pass element ids from ui_read: drag(from_id="el3", to_id="el8"). Requires approval unless Auto-approve actions is on.',
      parameters: {
        type: 'object',
        properties: {
          from_x: { type: 'number', description: 'Start x (absolute screen pixel).' },
          from_y: { type: 'number', description: 'Start y (absolute screen pixel).' },
          to_x: { type: 'number', description: 'End x (absolute screen pixel).' },
          to_y: { type: 'number', description: 'End y (absolute screen pixel).' },
          from_id: { type: 'string', description: 'Start element id from ui_read (e.g. "el3").' },
          to_id: { type: 'string', description: 'End element id from ui_read (e.g. "el8").' },
          steps: { type: 'number', description: 'Number of interpolation steps (default 20).' },
        },
      },
    },
  },
  uiLabel: () => 'Dragging',
  async execute(args) {
    let from: [number, number] | null = null;
    let to: [number, number] | null = null;

    try {
      const scene = await buildScene();
      rememberSceneElements(scene.elements);
      if (args.from_id !== undefined) {
        const el = resolveElementById(scene.elements, args.from_id);
        if (!el) return `Error: no element found for from_id "${String(args.from_id)}".`;
        from = el.center;
      } else if (
        typeof args.from_x === 'number' &&
        typeof args.from_y === 'number' &&
        Number.isFinite(args.from_x) &&
        Number.isFinite(args.from_y)
      ) {
        from = [args.from_x, args.from_y];
      }
      if (args.to_id !== undefined) {
        const el = resolveElementById(scene.elements, args.to_id);
        if (!el) return `Error: no element found for to_id "${String(args.to_id)}".`;
        to = el.center;
      } else if (
        typeof args.to_x === 'number' &&
        typeof args.to_y === 'number' &&
        Number.isFinite(args.to_x) &&
        Number.isFinite(args.to_y)
      ) {
        to = [args.to_x, args.to_y];
      }
      if (!from || !to) {
        return 'Error: drag needs from_x/from_y and to_x/to_y (pixels) or from_id/to_id (element ids from ui_read).';
      }
      await performDrag(from[0], from[1], to[0], to[1], args.steps as number | undefined);
      return `Dragged from (${from[0]}, ${from[1]}) to (${to[0]}, ${to[1]}).`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
