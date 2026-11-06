import { captureActiveWindowForAgent } from '../../capture/screenshot';
import { buildScene, formatQuickElementMap } from '../../capture/scene';
import { ocrImageB64Text } from '../../capture/ocr';
import { rememberSceneElements } from '../scene-cache';
import type { ToolDefinition } from './index';

// `see_screen` gives the agent a fresh look at the active window mid-task.
// The capture itself happens inside execute(); the router loop special-cases
// the result (JSON below) to attach the image to the conversation as a user
// message so the next round can actually SEE it.
//
// The same capture is ALSO OCR'd so the text readback rides along with the
// image — exactly like the trigger screenshot's OCR is attached on the first
// turn. Vision models read small UI text poorly; the OCR gives them the exact
// text in parallel with the pixels. Best-effort: no tesseract / a bad read
// yields an empty `ocrText`, never a failure.
//
// Result contract (JSON): { ok: true, imageB64, caption, ocrText } on success,
// or { ok: false, error } when the capture failed. Anything prefixed with
// "Error:" is also treated as a failure by the caller.

// A full-window capture can OCR to pages of text; cap the readback so it adds
// signal to the next round without eating the context budget.
const SEE_SCREEN_OCR_CHAR_CAP = 2000;

export const seeScreenTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'see_screen',
      description:
        "Capture a fresh screenshot of the active window and attach it to the conversation (along with its OCR text) so you can see the current state of the user's screen. The image is pre-sized so annotation coordinates match exactly — the caption reports the image dimensions and the coordinate space. Call this after open_url, launch_app, click, scroll, or type_text whenever you need to see the result before choosing the next action. BEFORE you annotate / point at / outline / mark up anything on screen, call see_screen() FIRST to attach the fresh shot, then draw your [POINT]/[BOX]/[ARROW] tags against that image's pixels.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  uiLabel: () => 'Looking at the screen',
  async execute() {
    try {
      const shot = await captureActiveWindowForAgent();
      if (!shot) {
        return JSON.stringify({
          ok: false,
          error: 'Could not capture the active window.',
        });
      }
      let ocrText = '';
      try {
        ocrText = (await ocrImageB64Text(shot.b64)).slice(0, SEE_SCREEN_OCR_CHAR_CAP);
      } catch {
        /* OCR is best-effort — the image still attaches without it */
      }
      // Numbered element map (best-effort): a UIA/AX snapshot of the target
      // window gives exact frames, so the model can pick targets by id
      // (ui_click("el3")) and reference [BOX:el#:label] right after a
      // see_screen — without a separate ui_read. `noText` skips the OCR/text
      // layers of buildScene: the shot above already provides the text.
      let elementMap = '';
      try {
        const scene = await buildScene({ noText: true });
        if (!scene.unavailable && scene.elements.length > 0) {
          rememberSceneElements(scene.elements);
          elementMap = formatQuickElementMap(scene);
        }
      } catch {
        /* element map is best-effort — the screenshot still attaches */
      }
      // The fresh shot REPLACES the reference frame: the size note restates
      // THIS image's real pixel bounds so annotation tags use the attached
      // image's space, never the earlier screenshot's size or the raw screen —
      // a model still anchored on the stale 1280x720 caption was measured to
      // write every coordinate ~1.25-1.9x ahead of its element.
      const sizeNote = shot.geo
        ? ` The screenshot just attached is ${shot.geo.region?.w ?? shot.geo.imgW} pixels wide by ${shot.geo.region?.h ?? shot.geo.imgH} pixels tall (actual display ${shot.geo.winW}x${shot.geo.winH}). Any [POINT]/[BOX]/[ARROW] annotation tags in your answer use pixels of THAT image: x from 0 to ${shot.geo.region?.w ?? shot.geo.imgW}, y from 0 to ${shot.geo.region?.h ?? shot.geo.imgH}. Estimate the numbers straight from the attached image — never multiply, divide, or convert.`
        : '';
      const caption = elementMap
        ? `${shot.caption}${sizeNote}\n\nElements on screen (numbered — click by id with ui_click("el#"), or BOX an exact frame with [BOX:el#:label]):\n${elementMap}`
        : `${shot.caption}${sizeNote}`;
      return JSON.stringify({
        ok: true,
        imageB64: shot.b64,
        caption,
        ocrText,
        geo: shot.geo,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: `Screen capture failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
};
