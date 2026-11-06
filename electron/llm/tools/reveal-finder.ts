import { shell } from 'electron';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getWorkspaceFolder } from '../../store/settings';
import type { ToolDefinition } from './index';

// Constrain the path the LLM can reveal to the user's configured workspace.
// Without this an injected prompt could reveal arbitrary directories like
// /Users/<other>/Documents, /private/etc, etc.
function isInsideWorkspace(target: string, workspace: string): boolean {
  const absTarget = resolve(target);
  const absWorkspace = resolve(workspace);
  if (absTarget === absWorkspace) return true;
  const prefix = absWorkspace.endsWith(sep) ? absWorkspace : absWorkspace + sep;
  return absTarget.startsWith(prefix);
}

export const revealInFinderTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'reveal_in_finder',
      description:
        'Open the Spirit workspace folder in the OS file manager (Finder on macOS, Explorer on Windows). Use when the user asks to "open my workspace", "show me my saved files", or "where are my docs".',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional path inside the workspace folder. Paths outside the workspace are rejected. If omitted, the workspace root is opened.',
          },
        },
      },
    },
  },
  uiLabel: () => 'Opening workspace',
  async execute(args) {
    const workspace = getWorkspaceFolder();
    const requested = String(args.path ?? '').trim();
    let target = workspace;
    if (requested) {
      if (!isInsideWorkspace(requested, workspace)) {
        // Refuse silently and fall back to workspace root, so a misbehaving
        // model does not leak information about which sensitive paths the
        // user has (e.g. by trying paths and observing different errors).
        target = workspace;
      } else {
        target = resolve(requested);
      }
    }
    if (!existsSync(target)) {
      return `Error: workspace folder does not exist: ${target}`;
    }
    try {
      shell.openPath(target).catch(() => undefined);
      return `Opened ${target} in the file manager.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
