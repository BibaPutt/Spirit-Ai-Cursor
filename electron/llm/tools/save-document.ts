import { shell } from 'electron';
import { saveResponseAuto } from '../../save/save';
import type { ToolDefinition } from './index';

export const saveDocumentTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'save_document',
      description:
        'Save the exact content you produced to disk and open it in the default app. The content is written VERBATIM — no template, no styling wrapper (a full HTML document is saved as .html, everything else as Markdown). Saves automatically to the Spirit workspace folder — no dialog, no manual steps. Use this when the user asks to "save this", "export", "write me a brief", or finishes a long write-up.',
      parameters: {
        type: 'object',
        properties: {
          suggested_name: {
            type: 'string',
            description:
              'Optional short filename suggestion (without extension), used as the saved file\'s name.',
          },
          content: {
            type: 'string',
            description:
              'Optional body to save. If omitted, the current assistant response is used.',
          },
        },
      },
    },
  },
  uiLabel: () => 'Saving to workspace',
  async execute(args, ctx) {
    const content = String(args.content ?? '').trim() || ctx.latestAssistantText.trim();
    if (!content) {
      return 'Error: no content to save. Generate the document content first, then call save_document.';
    }
    const rawSuggested = String(args.suggested_name ?? '').trim();
    // Strip path-traversal markers and characters that confuse filenames.
    const suggested = rawSuggested
      .replace(/[\\/]/g, '-')
      .replace(/\.\.+/g, '')
      .replace(/[\x00-\x1F<>:"|?*]/g, '')
      .slice(0, 80)
      .trim();
    const promptForName = suggested || ctx.originalPrompt || 'Spirit response';
    const result = await saveResponseAuto({ prompt: promptForName, content });
    if (result.ok) {
      try {
        await shell.openPath(result.path);
      } catch {
        /* opening is best-effort; the save itself succeeded */
      }
      return `Saved as ${result.format.toUpperCase()} to ${result.path} and opened it in the default app.`;
    }
    return `Error saving document: ${result.error ?? 'unknown'}`;
  },
};
