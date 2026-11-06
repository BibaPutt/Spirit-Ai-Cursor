import { performReadForegroundTitle, performType } from '../../input/engine';
import type { ToolDefinition } from './index';

// Whether a foreground-window title looks like Spirit's own UI (the overlay /
// prompt box) rather than a real target app — a warning tells the weak model
// the text may not have gone where it intended.
const SPIRIT_WINDOW_RE = /spirit|cua\.\s*agent|cursor overlay/i;

export const typeTextTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'type_text',
      description:
        'Type text into the currently focused application (Notepad, editors, browser inputs, dialogs). Use launch_app to open the app first, press_key to move the cursor where needed (e.g. ctrl+n for a new file), then call this ONCE with the full text. Types via clipboard paste, so every character and line break arrives intact.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The exact text to type, including code, newlines and special characters.',
          },
        },
        required: ['text'],
      },
    },
  },
  uiLabel: (args) => {
    const text = String(args.text ?? '');
    return text.length > 0 ? `Typing ${text.length} characters` : 'Typing…';
  },
  async execute(args) {
    const text = String(args.text ?? '');
    if (!text) return 'Error: type_text requires a "text" argument.';
    await performType(text);
    const fg = await performReadForegroundTitle();
    const where = fg ? `"${fg}"` : 'the focused window';
    const base = `Typed ${text.length} characters into ${where}.`;
    if (fg && SPIRIT_WINDOW_RE.test(fg)) {
      return (
        `Warning: the focused window (${where}) looks like Spirit's own UI — the text may not have reached the target app. ` +
        `Call focus_window(<target app>) first, then see_screen()/ui_read() to confirm, then type_text again. ` +
        base
      );
    }
    return base + ' If this is not the intended window, call focus_window(<target app>) and type again.';
  },
};
