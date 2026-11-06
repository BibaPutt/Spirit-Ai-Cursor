import { describeScreenshot, cropRegionB64 } from '../vision-bridge';
import { getCurrentImage } from '../current-image';
import type { ToolDefinition } from './index';

// `describe_region` lets the agent read a specific area of the screen through
// the vision bridge. Where see_screen sends OCR text (good at text, blind to
// icons/images) and the local model may be text-only (no image input at all),
// this crops a rectangular region of the current attached screenshot and asks
// the configured vision bridge to describe it — buttons, icons, charts,
// images, canvas content. Useful when the agent knows WHERE something is but
// OCR can't tell WHAT it is.
//
// The tool name starts with a verb and is registered in the TOOLS map so the
// provider's function-calling can call it like any other tool. It returns
// plain text (the bridge's description), so the router treats it as a normal
// read-only call — no image attach, no special casing. The model is told the
// coordinates are IMAGE pixels of the current attached screenshot (same space
// as [POINT]/[BOX] annotation tags).
//
// Gating: the tool is dropped from the provider's schema whenever the vision
// bridge is disabled (filterToolsForProvider in router.ts) — a model must
// never spend a round calling a tool that can't answer.

export const describeRegionTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'describe_region',
      description:
        'Read a specific rectangular region of the current attached screenshot through a separate vision model and return what is visible there (icons, buttons, images, charts, canvas content — things OCR cannot read). Coordinates are IMAGE PIXELS of the current attached screenshot, matching the same image space as [POINT]/[BOX] annotation tags: give x,y as the top-left corner and w,h as the size. Call see_screen first if the region you need isn\'t in the current screenshot, then describe_region against that fresh image.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Left edge of the region in image pixels (0-based).' },
          y: { type: 'number', description: 'Top edge of the region in image pixels (0-based).' },
          w: { type: 'number', description: 'Width of the region in image pixels.' },
          h: { type: 'number', description: 'Height of the region in image pixels.' },
          question: {
            type: 'string',
            description:
              'Optional: what to look for, e.g. "the icon in the toolbar" or "the error message at the top". Omit to get a full description of the region.',
          },
        },
        required: ['x', 'y', 'w', 'h'],
      },
    },
  },
  uiLabel: () => 'Reading a screen region',
  async execute(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    const w = Number(args.w);
    const h = Number(args.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      return 'Error: describe_region needs numeric x, y, w, h with w and h > 0.';
    }
    const imageB64 = getCurrentImage();
    if (!imageB64) {
      return 'Error: no screenshot in context. Call see_screen first to attach the current screen.';
    }
    const crop = await cropRegionB64(imageB64, x, y, w, h);
    if (!crop) {
      return 'Error: could not crop that region from the current screenshot.';
    }
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : undefined;
    const description = await describeScreenshot(crop, question);
    if (!description) {
      return 'Error: the vision bridge could not describe this region (unconfigured, timed out, or the vision model returned nothing).';
    }
    return `Vision readback of region (${x},${y} ${w}x${h}px):\n${description}`;
  },
};