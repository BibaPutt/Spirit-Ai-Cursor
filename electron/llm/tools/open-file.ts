import { shell } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { getWorkspaceFolder } from '../../store/settings';
import type { ToolDefinition } from './index';

function resolveOpenPath(requested: string): string {
  if (isAbsolute(requested)) return resolve(requested);
  const workspace = getWorkspaceFolder();
  const target = resolve(workspace, requested);
  const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;
  if (target !== workspace && !target.startsWith(prefix)) {
    throw new Error('path escapes the Spirit workspace; pass an absolute path to open elsewhere');
  }
  return target;
}

export const openFileTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'open_file',
      description:
        'Open a local file with its default app (e.g. dashboard.html opens in the browser, a .pdf in the PDF reader, a folder in Explorer/Finder). A relative path is resolved inside the Spirit workspace folder; an absolute path can open anywhere. Use when the user asks to "open the file", "show it", or you created an artifact with create_file and want the user to see it.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path of the file/folder to open. Relative = workspace folder; absolute = exact location.',
          },
        },
        required: ['path'],
      },
    },
  },
  uiLabel: (args) => {
    const p = String(args.path ?? '').trim();
    return p ? `Opening file: ${p}` : 'Opening file';
  },
  async execute(args) {
    const requested = String(args.path ?? '').trim();
    if (!requested) return 'Error: open_file requires a "path" argument.';
    let target: string;
    try {
      target = resolveOpenPath(requested);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!existsSync(target)) {
      return `Error: file does not exist: ${target}. Create it first with create_file, or pass a correct path.`;
    }
    try {
      shell.openPath(target).catch(() => undefined);
      return `Opened ${target} with its default app. Now call wait(1500), then use see_screen or ui_read before any further action.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};