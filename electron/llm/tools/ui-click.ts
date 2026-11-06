import { buildScene, resolveElementById } from '../../capture/scene';
import { rememberSceneElements, resolveSceneElementLabel } from '../scene-cache';
import { performClick, performReadForegroundTitle } from '../../input/engine';
import { CuaDriverError } from '../../input/cua-driver-client';
import { recordAppLesson } from '../../memory/app-lessons';
import type { ToolDefinition } from './index';

// `ui_click` clicks an element by its number from `ui_read`. The element id
// resolves to the exact center pixel, so the model never guesses coordinates.
// The scene is re-walked fresh at click time; if the window changed since the
// last ui_read, the number may point elsewhere — read ui_read again after big
// UI changes.

export const uiClickTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'ui_click',
      description:
        "Click an on-screen element by its number from ui_read — pass the id you saw, e.g. ui_click(\"el3\") or ui_click(3). The app finds the exact pixel and clicks it. This is the preferred way to click instead of guessing click(x, y) coordinates. Requires approval unless Auto-approve actions is on.",
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Element id from ui_read, e.g. "el3". A bare number (3) also works.',
          },
        },
        required: ['id'],
      },
    },
  },
  uiLabel: (args) => {
    // Approval cards and the activity rows should say what the model is
    // actually clicking ("Click button \"Downloads\""), not expose a raw
    // element id the human never saw. The scene cache remembers the last
    // ui_read/see_screen walk; when the id is unknown there, fall back to the
    // raw id rather than inventing a name.
    const id = String(args.id ?? '').trim();
    const el = resolveSceneElementLabel(id);
    if (el) {
      const name = el.name || '(unnamed icon)';
      const type = el.type?.trim().toLowerCase() || 'element';
      return `Click ${type} "${name}"`;
    }
    return `Clicking element ${id}`;
  },
  async execute(args) {
    try {
      const scene = await buildScene();
      rememberSceneElements(scene.elements);
      const target = resolveElementById(scene.elements, args.id);
      if (!target) {
        return `Error: no element found for id "${String(args.id)}". Call ui_read() to see the current numbered elements.`;
      }
      if (!target.enabled) {
        return `Error: element ${target.id} (${target.type} "${target.name}") is disabled.`;
      }
      await performClick(target.center[0], target.center[1]);
      const name = target.name || '(unnamed icon)';
      const verify = await verifyAfterClick(target);
      return `Clicked ${target.id} (${target.type} "${name}") at (${target.center[0]}, ${target.center[1]}). ${verify}`;
    } catch (err) {
      // Closed learning loop: a driver failure carrying a verdict code
      // (e.g. [background_unavailable]) becomes a lesson for THIS window, so
      // the next session's prompt already knows clicks here misbehave.
      if (err instanceof CuaDriverError) {
        const code = /\[([a-z_]+)\]/.exec(err.message)?.[1];
        if (code) {
          try {
            const title = (await performReadForegroundTitle()) || 'unknown';
            recordAppLesson(
              title,
              `cua:${code}`,
              `Clicks in this window previously failed with driver code ${code} — prefer ui_read element ids and verify after clicking.`,
            );
          } catch {
            /* lesson recording is best-effort */
          }
        }
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// Best-effort post-click sanity check. Re-walks the scene once and reports how
// the target behaved — a click that registered usually either dismisses the
// element (menu closed, modal gone), disables it (state change) or leaves it
// exactly where it was. Combined with the model's next ui_read this tells the
// planner whether to retry. Never throws: any walk failure just reports
// "unverified" so the click result still returns.
async function verifyAfterClick(
  target: import('../../capture/scene').SceneElement,
): Promise<string> {
  try {
    const after = await buildScene();
    const found = after.elements.find((e) => e.id === target.id);
    if (!found) {
      return 'Re-walked afterwards: the element is no longer present — the click likely registered (window changed).';
    }
    if (!found.enabled) {
      return 'Re-walked afterwards: the element is now disabled — the click registered.';
    }
    const dx = Math.abs(found.center[0] - target.center[0]);
    const dy = Math.abs(found.center[1] - target.center[1]);
    if (dx > 12 || dy > 12) {
      return `Re-walked afterwards: the element moved ${dx},${dy}px after the click — re-read ui_read() if you need it again.`;
    }
    return 'Re-walked afterwards: the element is still present and enabled at its spot.';
  } catch {
    return 'Could not re-verify the click (scene walk failed).';
  }
}
