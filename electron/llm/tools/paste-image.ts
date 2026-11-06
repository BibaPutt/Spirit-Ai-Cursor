import { clipboard, nativeImage } from 'electron';
import { pasteComboForPlatform, pressKey } from '../../input/actions';
import { captureScreenRegionB64 } from '../../capture/screenshot';
import type { ToolDefinition } from './index';

// `paste_image` pastes an image into the focused app — a screenshot clip, a
// chart, a photo. Three ways to supply the image:
//  - path: an image file on disk
//  - region: capture part of the screen ({x, y, width, height} absolute
//    pixels) and paste it
//  - neither: paste whatever image is already on the clipboard
// The image is left on the clipboard afterwards so the user can paste again.

export const pasteImageTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'paste_image',
      description:
        'Paste an image into the focused app (Word, OneNote, email, chat, etc.). Give a path to an image file, or a region {x, y, width, height} of absolute screen pixels to capture that part of the screen and paste it, or call with no arguments to paste the image already on the clipboard. The image stays on the clipboard afterwards. Requires approval unless Auto-approve actions is on.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to an image file (.png, .jpg, .jpeg, .bmp).',
          },
          region: {
            type: 'object',
            description:
              'Screen region to capture and paste, in absolute pixels (top-left = x, y): {x, y, width, height}.',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
        },
      },
    },
  },
  uiLabel: () => 'Pasting image',
  async execute(args) {
    let image: Electron.NativeImage | null = null;
    let source = '';

    if (args.path !== undefined) {
      image = nativeImage.createFromPath(String(args.path));
      if (image.isEmpty()) {
        return `Error: could not load the image at "${String(args.path)}". Check the path and that the file is a supported format.`;
      }
      source = `from "${String(args.path)}"`;
    } else if (args.region !== undefined && typeof args.region === 'object') {
      const r = args.region as Record<string, unknown>;
      const x = Number(r.x);
      const y = Number(r.y);
      const w = Number(r.width);
      const h = Number(r.height);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(w) ||
        !Number.isFinite(h) ||
        w <= 0 ||
        h <= 0
      ) {
        return 'Error: region needs valid numeric x, y, width, height (positive numbers).';
      }
      const b64 = await captureScreenRegionB64({ x, y, width: w, height: h });
      if (!b64) {
        return `Error: could not capture the screen region (${x}, ${y}) ${w}x${h}.`;
      }
      image = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
      if (image.isEmpty()) return 'Error: the screen capture produced an empty image.';
      source = `of the screen region (${x}, ${y}) ${w}x${h}`;
    } else {
      image = clipboard.readImage();
      if (image.isEmpty()) {
        return 'Error: the clipboard does not contain an image. Copy an image first, or pass a path or a region.';
      }
      source = 'already on the clipboard';
    }

    try {
      clipboard.writeImage(image);
      await pressKey(pasteComboForPlatform());
      return `Pasted an image ${source} into the focused app. The image is still on the clipboard.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
