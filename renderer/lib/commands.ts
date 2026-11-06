import type { TemplateId } from '../../electron/types';

export type CommandId =
  | 'settings'
  | 'help'
  | 'clear'
  | 'web'
  | 'quit'
  | 'history'
  | 'lastsession'
  | 'memory'
  | 'test'
  | TemplateId;

export type Command = {
  id: CommandId;
  name: string;
  description: string;
  argsHint?: string;
  group: 'mode' | 'template' | 'action';
};

export const COMMANDS: readonly Command[] = [
  // Modes
  { id: 'web', name: '/web', description: 'Web-grounded answer for this query', argsHint: '<question>', group: 'mode' },
  // Templates
  { id: 'summary', name: '/summary', description: 'Long markdown summary, ready to save as PDF', argsHint: '<topic>', group: 'template' },
  { id: 'brief', name: '/brief', description: 'TL;DR + 3–5 bullets', argsHint: '<topic>', group: 'template' },
  { id: 'translate', name: '/translate', description: 'Translate visible / selected / pasted text', argsHint: '[target language]', group: 'template' },
  { id: 'explain', name: '/explain', description: 'Plain-English explainer', argsHint: '<thing>', group: 'template' },
  { id: 'code', name: '/code', description: 'Code-focused answer with snippet', argsHint: '<task or error>', group: 'template' },
  { id: 'improve', name: '/improve', description: 'Rewrite text for clarity', argsHint: '[guidance]', group: 'template' },
  { id: 'define', name: '/define', description: 'Quick dictionary entry', argsHint: '<word>', group: 'template' },
  { id: 'solve', name: '/solve', description: 'Math / logic step-by-step', argsHint: '<problem>', group: 'template' },
  { id: 'reply', name: '/reply', description: '3 reply variants for a message', argsHint: '[guidance]', group: 'template' },
  { id: 'identify', name: '/identify', description: 'Identify object / product / landmark', argsHint: '[hint]', group: 'template' },
  // Actions
  { id: 'settings', name: '/settings', description: 'Open settings', group: 'action' },
  { id: 'history', name: '/history', description: 'List past sessions (workspace)', group: 'action' },
  { id: 'lastsession', name: '/lastsession', description: 'Reopen the most recent saved session', group: 'action' },
  { id: 'memory', name: '/memory', description: 'Browse, edit, or delete long-term context memory', group: 'action' },
  { id: 'test', name: '/test', description: 'Seed fake past conversation to test the UI (no LLM call)', argsHint: '[test-name]', group: 'action' },
  { id: 'help', name: '/help', description: 'Show available commands', group: 'action' },
  { id: 'clear', name: '/clear', description: 'Dismiss the current response', group: 'action' },
  { id: 'quit', name: '/quit', description: 'Quit Spirit', group: 'action' },
];

export type ParsedCommand = {
  command: Command;
  args: string;
};

export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = (space === -1 ? input : input.slice(0, space)).toLowerCase();
  const args = space === -1 ? '' : input.slice(space + 1).trim();
  const command = COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}

export function matchCommands(prefix: string): Command[] {
  if (!prefix.startsWith('/')) return [];
  const space = prefix.indexOf(' ');
  if (space !== -1) return [];
  const q = prefix.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
}

export const TEMPLATE_IDS: ReadonlyArray<CommandId> = [
  'summary',
  'brief',
  'translate',
  'explain',
  'code',
  'improve',
  'define',
  'solve',
  'reply',
  'identify',
];

export function isTemplateCommand(id: CommandId): id is TemplateId {
  return TEMPLATE_IDS.includes(id);
}

export const HELP_TEXT = `## Commands

### Modes
- \`/web <question>\` — force web-grounded answer for this one query.

### Templates
- \`/summary <topic>\` — structured markdown summary, ready to save as A4 PDF.
- \`/brief <topic>\` — one-screen TL;DR with bullet support.
- \`/translate [language] <text>\` — translate text in the screenshot, clipboard, or args.
- \`/explain <thing>\` — plain-English explainer.
- \`/code <task or error>\` — code-focused answer with a snippet.
- \`/improve <text>\` — rewrite for clarity and rhythm.
- \`/define <word>\` — concise dictionary entry with example.
- \`/solve <problem>\` — math / logic answer with steps.
- \`/reply [guidance]\` — three reply variants (casual / professional / direct) for a visible message.
- \`/identify [hint]\` — what is this object / product / landmark in the screenshot.

### Actions
- \`/settings\` — open settings.
- \`/history\` — list past sessions saved to your workspace.
- \`/lastsession\` — restore the most recent saved session into the box (useful when you closed by accident).
- \`/memory\` — browse, edit, or delete what Spirit remembers about you across sessions.
- \`/test [name]\` — list UI test seeds (or seed one directly) to exercise the transcript rail with fake turns.
- \`/clear\` — dismiss the current response.
- \`/help\` — this list.
- \`/quit\` — quit Spirit.

## What Spirit sees
At trigger, Spirit captures **one** screenshot — by default a 512×384 region centred on your cursor. The blue **"Screenshot attached"** chip above the input shows it's on; click the **×** to send the next prompt without vision.
- **Region screenshots:** while the box is open, hold the trigger key a second time and drag a rectangle. That region replaces the default crop.
- **Multi-turn:** follow-up questions in the same session reuse the original screenshot — Spirit never re-captures itself.
- **Clipboard is opt-in:** click the **paperclip icon** left of the mic to include your current clipboard text in the next prompt. The clipboard chip appears, X to remove.

## Voice tools
Say it in any of EN / DE / FR / ES / IT / PT / NL:
- "open Slack" / "öffne den Rechner" → launches the app
- "play Mozart" / "spiele Bach" → opens music
- "search for penguins" / "such nach Pinguinen" → opens DuckDuckGo
- "louder" / "quieter" / "mute" / "set volume to 30" / "lauter" / "leiser" / "stumm" → system volume
- "stop" / "halt" / "be quiet" / "sei ruhig" → interrupts the voice conversation loop

## What Spirit can do
The model can call tools mid-answer:
- \`fetch_url\`, \`read_clipboard\` — read-only, run automatically
- \`open_url\`, \`copy_to_clipboard\`, \`save_document\`, \`reveal_in_finder\` — destructive, ask before running

Web search via \`/web <question>\` or auto-detected from intent.

## Gestures
- Hold Right-Cmd / Right-Ctrl 200 ms → trigger. Hold again over an open box → arm region selection.
- ESC → dismiss / cancel selection. Enter → submit. ↑/↓ → navigate autocomplete. Tab → complete.
- Drag the box header (or any empty area inside it) → reposition.
- Double-click outside the box → dismiss (switchable to single-click in Settings → Behaviour).

## Privacy
No telemetry, no analytics, no background calls. Everything routes through the LLM provider you configured.`;
