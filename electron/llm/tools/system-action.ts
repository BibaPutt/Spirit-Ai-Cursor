import { shell } from 'electron';
import { buildIntentUrl, type IntentKind } from '../../apps/deep-links';
import { getSettings } from '../../store/settings';
import type { ToolDefinition } from './index';

// `system_action` hands an intent to the REAL app, pre-filled, instead of
// clicking through a browser. "Add to my calendar", "email Sarah", "directions
// to X", "find a restaurant near me", "text a number on WhatsApp" all open the
// OS/browser default app already half-done — the user just taps Save/Send.
// Approval-required (opens external apps/URLs).

const INTENT_KINDS: IntentKind[] = [
  'calendar_event',
  'email',
  'map_directions',
  'map_search',
  'call_whatsapp',
];

export const systemActionTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'system_action',
      description:
        'Hand a real-world intent to the user\'s apps, pre-filled. Use for: "add this to my calendar" (calendar_event), "email/reply to someone" (email), "directions to X" (map_directions), "find X near me" (map_search), "message/text a phone number on WhatsApp" (call_whatsapp). Extract the dates, recipient, location, or query from the visible context. Do NOT click through a browser for these — open the real app pre-filled and let the user confirm.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: INTENT_KINDS,
            description: 'The intent to perform.',
          },
          title: { type: 'string', description: 'calendar_event: event title.' },
          start: {
            type: 'string',
            description:
              'calendar_event: start date/time as ISO-8601 local time, e.g. 2026-08-17T14:00. Compute it from the visible context.',
          },
          end: {
            type: 'string',
            description:
              'calendar_event: end date/time as ISO-8601 local time, e.g. 2026-08-17T15:00.',
          },
          allDay: {
            type: 'boolean',
            description: 'calendar_event: true for an all-day event.',
          },
          location: { type: 'string', description: 'calendar_event: event location.' },
          details: { type: 'string', description: 'calendar_event: notes/description.' },
          provider: {
            type: 'string',
            enum: ['google', 'outlook'],
            description: 'calendar_event: which calendar service (defaults to the user setting).',
          },
          recipient: { type: 'string', description: 'email: recipient email address.' },
          subject: { type: 'string', description: 'email: subject line.' },
          body: { type: 'string', description: 'email: message body.' },
          destination: { type: 'string', description: 'map_directions: where to go.' },
          origin: { type: 'string', description: 'map_directions: starting point (optional).' },
          query: { type: 'string', description: 'map_search: what to find.' },
          phone: { type: 'string', description: 'call_whatsapp: phone number.' },
          message: { type: 'string', description: 'call_whatsapp: pre-filled message (optional).' },
        },
        required: ['kind'],
      },
    },
  },
  uiLabel: (args) => {
    const kind = String(args.kind ?? '');
    const primary =
      (args.title as string) ||
      (args.recipient as string) ||
      (args.destination as string) ||
      (args.query as string) ||
      (args.phone as string) ||
      '';
    const label =
      kind === 'calendar_event'
        ? `Adding "${primary}" to calendar`
        : kind === 'email'
          ? `Opening email to ${primary}`
          : kind === 'map_directions'
            ? `Opening directions to ${primary}`
            : kind === 'map_search'
              ? `Searching maps for ${primary}`
              : kind === 'call_whatsapp'
                ? `Opening WhatsApp chat`
                : `Opening app`;
    return label.slice(0, 60);
  },
  async execute(args) {
    const kind = String(args.kind ?? '') as IntentKind;
    if (!INTENT_KINDS.includes(kind)) {
      return `Error: unknown system_action kind "${kind}".`;
    }
    // Default the calendar provider from the user's setting when not passed.
    const provider =
      kind === 'calendar_event' && !args.provider
        ? getSettings().calendarProvider
        : (args.provider as 'google' | 'outlook' | undefined);
    const built = buildIntentUrl(kind, {
      ...args,
      provider: provider as 'google' | 'outlook' | undefined,
    });
    if (!built.ok) return `Error: ${built.error}`;
    try {
      await shell.openExternal(built.url);
      return `Opened ${built.label}. Now call wait(1500), then see_screen or ui_read before acting on the opened app.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
