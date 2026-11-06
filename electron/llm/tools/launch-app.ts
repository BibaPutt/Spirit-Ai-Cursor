import type { ToolDefinition } from './index';
import { focusLaunchedApp, launchApp } from '../../apps/launcher';

// `launch_app` opens ANY desktop application installed on the user's machine
// by name. The name is resolved against the live app registry (Start Menu /
// UWP on Windows, /Applications on macOS, .desktop files on Linux) with a
// fuzzy match and a platform fallback. No hardcoded app list.
//
// Approval-gating is handled in the approval router (tools/approval.ts):
// launch_app is in the "always requires approval" set, so every launch
// is user-approved before execute runs.

export const launchAppTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'launch_app',
      description:
        'Open any desktop application installed on the user\'s machine by name (e.g. "Spotify", "Photoshop", "Word", "Notepad"). Use this when the user says "open X", "start X", "let me use X". If you are unsure the app is installed, call list_apps first.',
      parameters: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'Name of the app to open, as the user said it.',
          },
        },
        required: ['app'],
      },
    },
  },
  uiLabel: (args) => {
    const name = String(args.app ?? '').trim();
    if (!name) return 'Opening app';
    return `Opening ${name}`;
  },
  async execute(args) {
    const name = String(args.app ?? '').trim();
    if (!name) return 'Error: launch_app requires an "app" argument.';
    const res = await launchApp(name);
    if (!res.ok) return `Error: ${res.error}`;
    await focusLaunchedApp(name);
    return `Opened ${name}. Now call wait(1500), then see_screen or ui_read before acting on the window.`;
  },
};
