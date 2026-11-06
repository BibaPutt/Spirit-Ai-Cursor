// Intent-based deep links — "add to my calendar", "email Sarah", "directions
// to X". Each intent is turned into a pre-filled URL the OS/browser opens with
// the REAL app already half-done (Google Calendar template, mailto, Maps
// directions). The user keeps final control by hitting Save/Send.
//
// Purely functional URL builders — no Electron imports, so this module is
// unit-testable. Values are always encodeURIComponent-escaped; the only
// schemes ever produced are https/http/mailto.

export type IntentKind =
  | 'calendar_event'
  | 'email'
  | 'map_directions'
  | 'map_search'
  | 'call_whatsapp';

export type CalendarProvider = 'google' | 'outlook';

export type BuildIntentArgs = {
  // calendar_event
  title?: string;
  start?: string;      // ISO-8601 local time, e.g. 2026-08-17T14:00
  end?: string;        // ISO-8601 local time
  allDay?: boolean;
  location?: string;
  details?: string;
  provider?: CalendarProvider;
  // email
  recipient?: string;
  subject?: string;
  body?: string;
  // map_directions
  destination?: string;
  origin?: string;
  // map_search
  query?: string;
  // call_whatsapp
  phone?: string;
  message?: string;
};

const INTENT_HOSTS = new Set([
  'calendar.google.com',
  'outlook.live.com',
  'www.google.com',
  'open.spotify.com',
]);

function esc(value: unknown): string {
  return encodeURIComponent(String(value ?? '').trim());
}

// Build a Google Calendar "create event" URL (action=TEMPLATE). Dates must be
// YYYYMMDD or YYYYMMDDTHHMMSS in the calendar's local timezone.
function googleCalendarUrl(args: BuildIntentArgs): string {
  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  if (args.title) params.set('text', String(args.title));
  if (args.location) params.set('location', String(args.location));
  if (args.details) params.set('details', String(args.details));
  const start = compactDate(args.start, args.allDay);
  if (start) {
    const end = compactDate(args.end, args.allDay);
    params.set('dates', end && end !== start ? `${start}/${end}` : start);
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Build an Outlook.com "new event" URL (calendar compose).
function outlookCalendarUrl(args: BuildIntentArgs): string {
  const params = new URLSearchParams();
  if (args.title) params.set('subject', String(args.title));
  if (args.location) params.set('location', String(args.location));
  if (args.details) params.set('body', String(args.details));
  if (args.start) params.set('startdt', String(args.start));
  if (args.end) params.set('enddt', String(args.end));
  return `https://outlook.live.com/calendar/0/action/compose?${params.toString()}`;
}

// Normalize an ISO date to Google's compact YYYYMMDD[THHMMSS] form, or drop
// the time component for all-day events.
function compactDate(iso: string | undefined, allDay?: boolean): string | undefined {
  if (!iso) return undefined;
  const trimmed = iso.trim();
  if (!trimmed) return undefined;
  if (allDay) {
    const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}${m[2]}${m[3]}` : undefined;
  }
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`;
  const d = trimmed.match(/^(\d{4})(\d{2})(\d{2})/);
  return d ? trimmed.replace(/[:]/g, '') : undefined;
}

// Loose email check — good enough to reject obvious garbage while never
// blocking a valid address.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Loose international phone check — digits, +, spaces, dashes, parens.
export function isValidPhone(phone: string): boolean {
  return /^[+0-9()\-\s.]{6,20}$/.test(phone.trim());
}

// Calendar dates must be real ISO-8601 values in a plausible window (the
// current year ± 1). Weak models invent dates like "2025-13-40" or the distant
// future; the returned error names TODAY's date so the model can recompute
// instead of guessing again. Called before the event URL is built.
export function validateCalendarDates(
  start: string | undefined,
  end: string | undefined,
  allDay?: boolean,
  now = new Date(),
): string | null {
  const check = (iso: string): string | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2})?)?$/.exec(iso.trim());
    if (!m) return `"${iso}" is not a valid ISO date. Use e.g. 2026-08-17T14:00 or 2026-08-17.`;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = m[4] === undefined ? undefined : Number(m[4]);
    const minute = m[5] === undefined ? undefined : Number(m[5]);
    if (year < now.getFullYear() - 1 || year > now.getFullYear() + 1) {
      return `"${iso}" is out of range (today is ${now.toISOString().slice(0, 10)}). Pick a date near today.`;
    }
    if (month < 1 || month > 12) return `"${iso}" has an invalid month.`;
    const maxDay = new Date(year, month, 0).getDate();
    if (day < 1 || day > maxDay) return `"${iso}" has an invalid day.`;
    if (hour !== undefined && hour > 23) return `"${iso}" has an invalid hour.`;
    if (minute !== undefined && minute > 59) return `"${iso}" has an invalid minute.`;
    return null;
  };
  if (start && start.trim()) {
    const err = check(start);
    if (err) return err;
    if (allDay && !/^\d{4}-\d{2}-\d{2}$/.test(start.trim())) {
      return 'All-day events must use a date only (2026-08-17), not a time.';
    }
  }
  if (end && end.trim()) {
    const err = check(end);
    if (err) return err;
  }
  if (start && end) {
    const s = Date.parse(start.trim());
    const e = Date.parse(end.trim());
    if (!Number.isNaN(s) && !Number.isNaN(e) && e <= s) {
      return 'The event end time must be after the start time.';
    }
  }
  return null;
}

export type IntentResult =
  | { ok: true; url: string; label: string }
  | { ok: false; error: string };

// Build the deep-link URL for an intent. Returns a label describing what will
// open so the approval UI and activity row can show it.
export function buildIntentUrl(kind: IntentKind, args: BuildIntentArgs): IntentResult {
  switch (kind) {
    case 'calendar_event': {
      if (!args.title) return { ok: false, error: 'calendar_event requires a "title".' };
      const dateErr = validateCalendarDates(args.start, args.end, args.allDay);
      if (dateErr) return { ok: false, error: `calendar_event: ${dateErr}` };
      const provider = args.provider ?? 'google';
      const url =
        provider === 'outlook'
          ? outlookCalendarUrl(args)
          : googleCalendarUrl(args);
      return {
        ok: true,
        url,
        label: `Adding "${args.title}" to calendar`,
      };
    }
    case 'email': {
      const recipient = (args.recipient ?? '').trim();
      if (!recipient) return { ok: false, error: 'email requires a "recipient".' };
      if (!isValidEmail(recipient)) {
        return { ok: false, error: `"${recipient}" is not a valid email address.` };
      }
      const params = new URLSearchParams();
      if (args.subject) params.set('subject', String(args.subject));
      if (args.body) params.set('body', String(args.body));
      const qs = params.toString();
      const url = `mailto:${encodeURIComponent(recipient)}${qs ? `?${qs}` : ''}`;
      return { ok: true, url, label: `Opening email to ${recipient}` };
    }
    case 'map_directions': {
      const destination = (args.destination ?? '').trim();
      if (!destination) return { ok: false, error: 'map_directions requires a "destination".' };
      const params = new URLSearchParams();
      params.set('api', '1');
      params.set('destination', destination);
      if (args.origin) params.set('origin', String(args.origin));
      const url = `https://www.google.com/maps/dir/?${params.toString()}`;
      return { ok: true, url, label: `Opening directions to ${destination}` };
    }
    case 'map_search': {
      const query = (args.query ?? '').trim();
      if (!query) return { ok: false, error: 'map_search requires a "query".' };
      const url = `https://www.google.com/maps/search/${esc(query)}`;
      return { ok: true, url, label: `Searching maps for ${query}` };
    }
    case 'call_whatsapp': {
      const phone = (args.phone ?? '').trim();
      if (!phone) return { ok: false, error: 'call_whatsapp requires a "phone".' };
      if (!isValidPhone(phone)) {
        return { ok: false, error: `"${phone}" is not a valid phone number.` };
      }
      const digits = phone.replace(/\D/g, '');
      const url = `https://wa.me/${digits}${args.message ? `?text=${esc(args.message)}` : ''}`;
      return { ok: true, url, label: `Opening WhatsApp chat with ${phone}` };
    }
    default:
      return { ok: false, error: `Unknown intent kind: ${kind}.` };
  }
}

export function isValidIntentHost(hostname: string): boolean {
  return INTENT_HOSTS.has(hostname);
}
