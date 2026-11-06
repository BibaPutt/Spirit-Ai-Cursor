import { clipboard } from 'electron';
import type { ToolDefinition } from './index';

const MAX_CHARS = 100_000;

// Strip ANSI escape codes and most control characters. Keep tab, LF, CR.
function sanitize(input: string): string {
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  // eslint-disable-next-line no-control-regex
  const controls = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g;
  return input.replace(ansi, '').replace(controls, '');
}

export const copyClipboardTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'copy_to_clipboard',
      description:
        'Copy a string to the user\'s system clipboard. Use this when the user asks you to "copy that", "put this in my clipboard", or extracts a snippet they\'ll paste elsewhere.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to place on the clipboard. Max 100,000 characters.',
          },
        },
        required: ['text'],
      },
    },
  },
  uiLabel: () => 'Copying to clipboard',
  async execute(args) {
    let text = String(args.text ?? '');
    if (!text) return 'Error: copy_to_clipboard requires a non-empty "text" argument.';
    text = sanitize(text);
    let trimmedNote = '';
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      trimmedNote = ` (trimmed to ${MAX_CHARS})`;
    }
    clipboard.writeText(text);
    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
    return `Copied ${text.length} characters to the clipboard${trimmedNote}: "${preview}"`;
  },
};
