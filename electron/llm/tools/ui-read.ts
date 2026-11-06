import { buildScene, buildClickTargetsMenu, formatScene, goalScoreFor, goalTokens, textSourceForGoal } from '../../capture/scene';
import { rememberSceneElements } from '../scene-cache';
import type { ToolDefinition, ToolExecutionContext } from './index';

// `ui_read` turns the active window into a NUMBERED list of buttons, links,
// inputs and visible text (element ids el0, el1, … with screen positions).
// The model then clicks by number with `ui_click` instead of guessing pixel
// coordinates. Read-only, never requires approval, never deduped by the router
// (each call reads a fresh scene).

export const uiReadTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'ui_read',
      description:
        "Read the ACTIVE window and get a numbered list of the buttons, links, inputs and visible text on it (each element has an id like el0, el1, el2 with its screen position in the same coordinate space as click/move_mouse). Call this before clicking anything — especially after open_url, launch_app, or navigating — so you can pick a target by number instead of guessing pixel coordinates. Read-only; never requires approval.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  uiLabel: () => 'Reading the screen elements',
  async execute(_args: Record<string, unknown>, ctx: ToolExecutionContext) {
    try {
      // Action requests ("click Download Now") need OCR word boxes — they carry
      // the screen coordinates the agent clicks. Reading requests ("what does
      // this page say?") webfetch the page text instead of OCR-ing the browser.
      const goalText = [ctx.sessionGoal, ctx.originalPrompt].filter(Boolean).join(' ');
      const scene = await buildScene({ textSource: textSourceForGoal(goalText) });
      rememberSceneElements(scene.elements);
      const list = formatScene(scene);
      if (scene.unavailable) return list;
      // Goal-aware menu: elements whose label matches the user's request are
      // listed first (e.g. "Download Now" when the user asked to download),
      // so a weak model sees its target in the first lines. The goal is the
      // session's original request combined with the current turn's prompt,
      // so follow-ups like "ok" keep targeting the original ask.
      const menu = buildClickTargetsMenu(scene, 6, goalText);
      const menuBlock =
        menu.length > 0
          ? 'BEST CLICK TARGETS (short labels most likely to matter — read these first):\n' +
            menu
              .map(
                (e) =>
                  `${e.id} ${e.type === 'text' ? 'text' : e.type} "${e.name}" at (${e.center[0]}, ${e.center[1]})`,
              )
              .join('\n') +
            '\n\n'
          : '';
      // Explicit goal-match line: hand the weak model the exact id instead of
      // making it map "download" onto the list itself.
      const tokens = goalTokens(goalText);
      let goalLine = '';
      if (tokens.length > 0) {
        const hits = menu.filter((e) => goalScoreFor(e.name, tokens) > 0);
        if (hits.length > 0) {
          goalLine =
            `The user's request matches these elements: ` +
            hits.map((e) => `${e.id} "${e.name}"`).join(', ') +
            `. If that matches what the user asked for, call ui_click with that id now.\n\n`;
        }
      }
      return (
        menuBlock +
        goalLine +
        'FULL LIST:\n' +
        list +
        '\n\n' +
        'DECISION: This is the current screen. If the element you need is listed above, call ui_click with its id. ' +
        'If you want to BOX an element in your final answer, reference its id in a [BOX:el# :label] tag ' +
        '(e.g. [BOX:el3:Save button]) — the app boxes its exact frame on screen; the tag is stripped from the answer.' +
        'If your target is NOT in this list (e.g. the download button you can see in the screenshot is below this ' +
        'portion of the page), do NOT call ui_read again — instead click it by pixel with click(x, y) using the ' +
        'screenshot you already have.'
      );
    } catch (err) {
      return `Error: could not read screen elements: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
