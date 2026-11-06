import { performFocusWindow, performReadForegroundTitle } from '../../input/engine';
import { recordAppLesson } from '../../memory/app-lessons';
import type { ToolDefinition } from './index';

// `focus_window` brings a desktop app's window to the foreground so the next
// type_text / press_key / ui_read / ui_click target THAT app instead of
// whatever had focus (often Spirit's own overlay). launch_app alone does not
// guarantee focus, so the agent calls this explicitly before typing/clicking
// in an app it needs to drive. Returns a VERDICT: the now-foreground window's
// title, so a weak model can tell whether focus actually landed and re-try.

export type FocusPlan = {
  names: string[];
  title?: string;
};

// Pure arg planner: `app` → process-name focus, `window` → title-substring
// focus (both are allowed; app is attempted first). Returns an error object
// when neither is given.
export function buildFocusPlan(args: Record<string, unknown>): { plan: FocusPlan } | { error: string } {
  const app = String(args.app ?? '').trim().replace(/\.exe$/i, '');
  const title = String(args.window ?? '').trim();
  if (!app && !title) {
    return {
      error:
        'focus_window needs an "app" name (e.g. "Notepad", "Chrome") or a "window" title hint (e.g. "My Notes — Notepad").',
    };
  }
  return { plan: { names: app ? [app] : [], title: title || undefined } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const focusWindowTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'focus_window',
      description:
        "Bring a desktop app's window to the FOREGROUND so the next type_text / press_key / ui_click target it — type and clicks go to the window with keyboard focus, which after launch_app may still be the user's previous app. Pass the app name (same as launch_app, e.g. focus_window(\"Notepad\")) and/or a window-title hint. Call this BEFORE typing or clicking in an app, and re-call it whenever actions seem to be landing in the wrong window. Returns the now-foremost window's title so you can verify focus landed. Requires approval unless Auto-approve actions is on.",
      parameters: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'The app to focus, e.g. "Notepad", "Word", "Chrome". Same name you would pass to launch_app.',
          },
          window: {
            type: 'string',
            description: 'Optional window-title substring to focus a specific window of an app (e.g. "tasklist.txt — Notepad").',
          },
        },
        required: [],
      },
    },
  },
  uiLabel: (args) => {
    const app = String(args.app ?? '').trim();
    const title = String(args.window ?? '').trim();
    return app || title ? `Focusing ${app || title}` : 'Focusing a window';
  },
  async execute(args) {
    const built = buildFocusPlan(args);
    if ('error' in built) return built.error;
    const { plan } = built;
    const targetDesc = plan.names[0] || plan.title || 'the window';

    const focused = await performFocusWindow(plan);
    // Let the activation settle before reading the verdict.
    await sleep(150);
    const fg = await performReadForegroundTitle();

    if (!focused) {
      const lesson =
        `focus_window("${targetDesc}") found no visible window. ` +
        `Match it via list_apps first (or pass a window-title hint) before calling focus_window again.`;
      recordAppLesson(targetDesc, 'focus:no-match', lesson);
      return (
        `Could not focus ${targetDesc}: no visible window matched it. ` +
        `Check the app is running (list_apps, see_screen), wait(1500) and call focus_window again, ` +
        `or relaunch it with launch_app(${JSON.stringify(targetDesc)}).`
      );
    }
    const foreText = fg ? `"${fg}"` : 'unknown (title not readable)';
    const lowerFg = (fg ?? '').toLowerCase();
    const matchTarget =
      (plan.title && lowerFg.includes(plan.title.toLowerCase())) ||
      plan.names.some((n) => lowerFg.includes(n.toLowerCase()));
    if (fg && !matchTarget) {
      // Focus landed but on the WRONG window: the app's window title doesn't
      // contain the app name (e.g. "tasklist.txt — Notepad" is titled by the
      // document). Teach future sessions to pass a window-title hint.
      const lesson =
        `focus_window("${targetDesc}") foregrounded "${fg}", which does not match the requested name. ` +
        `Pass a window-title hint (e.g. focus_window(window: "…)") to hit the right window.`;
      recordAppLesson(targetDesc, 'focus:title-mismatch', lesson);
    }
    const confirmed = matchTarget ? ' Confirmed: the target is foreground.' : '';
    return (
      `Focused ${targetDesc} — the foreground window is now ${foreText}. ` +
      `type_text / press_key / ui_click now target it.` +
      `${confirmed} ` +
      `Call ui_read() to get its numbered elements (and see_screen() to look at it) before clicking or typing.`
    );
  },
};