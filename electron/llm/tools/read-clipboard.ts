import { clipboard } from 'electron';
import type { ToolDefinition } from './index';

const MAX_CHARS = 8000;

export const readClipboardTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'read_clipboard',
      description:
        'Read the current contents of the system clipboard. Use only when the user explicitly references "the thing I copied", asks you to operate on clipboard contents, and clipboard context was not already included in the user message.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  uiLabel: () => 'Reading clipboard',
  async execute() {
    const text = clipboard.readText();
    if (!text) return 'Clipboard is empty.';
    if (text.length > MAX_CHARS) {
      return `Clipboard contents (${text.length} chars, truncated to ${MAX_CHARS}):\n${text.slice(0, MAX_CHARS)}\n…[truncated]`;
    }
    return `Clipboard contents (${text.length} chars):\n${text}`;
  },
};
