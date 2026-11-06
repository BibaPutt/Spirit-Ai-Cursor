import { describe, expect, it } from 'vitest';
import {
  buildIntentUrl,
  isValidEmail,
  isValidIntentHost,
  isValidPhone,
  validateCalendarDates,
} from '../electron/apps/deep-links';

describe('buildIntentUrl calendar_event', () => {
  it('builds a Google Calendar TEMPLATE URL with dates, location, details', () => {
    const res = buildIntentUrl('calendar_event', {
      title: 'Team standup',
      start: '2026-08-17T14:00',
      end: '2026-08-17T14:30',
      location: 'Room 4',
      details: 'Weekly sync',
    });
    expect(res).toMatchObject({ ok: true, label: 'Adding "Team standup" to calendar' });
    if (res.ok) {
      const url = new URL(res.url);
      expect(url.hostname).toBe('calendar.google.com');
      expect(url.pathname).toBe('/calendar/render');
      expect(url.searchParams.get('action')).toBe('TEMPLATE');
      expect(url.searchParams.get('text')).toBe('Team standup');
      expect(url.searchParams.get('dates')).toBe('20260817T140000/20260817T143000');
      expect(url.searchParams.get('location')).toBe('Room 4');
      expect(url.searchParams.get('details')).toBe('Weekly sync');
    }
  });

  it('treats all-day events as date-only YYYYMMDD', () => {
    const res = buildIntentUrl('calendar_event', {
      title: 'Holiday',
      start: '2026-12-25',
      allDay: true,
    });
    if (res.ok) {
      expect(new URL(res.url).searchParams.get('dates')).toBe('20261225');
    }
  });

  it('uses the outlook provider when requested', () => {
    const res = buildIntentUrl('calendar_event', {
      title: 'Lunch',
      start: '2026-08-17T12:00',
      end: '2026-08-17T13:00',
      provider: 'outlook',
    });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      const url = new URL(res.url);
      expect(url.hostname).toBe('outlook.live.com');
      expect(url.searchParams.get('subject')).toBe('Lunch');
      expect(url.searchParams.get('startdt')).toBe('2026-08-17T12:00');
      expect(url.searchParams.get('enddt')).toBe('2026-08-17T13:00');
    }
  });

  it('requires a title', () => {
    const res = buildIntentUrl('calendar_event', { start: '2026-08-17T14:00' });
    expect(res).toMatchObject({ ok: false, error: 'calendar_event requires a "title".' });
  });
});

describe('validateCalendarDates', () => {
  const now = new Date('2026-08-16T12:00:00Z');

  it('accepts a valid datetime and a valid date-only', () => {
    expect(validateCalendarDates('2026-08-17T14:00', '2026-08-17T15:00', false, now)).toBeNull();
    expect(validateCalendarDates('2026-12-25', undefined, true, now)).toBeNull();
  });

  it('rejects a malformed ISO date', () => {
    expect(validateCalendarDates('tomorrow at 2', undefined, undefined, now)).toContain(
      'not a valid ISO date',
    );
  });

  it('rejects dates far from today and names today in the error', () => {
    const err = validateCalendarDates('2024-01-01', undefined, undefined, now);
    expect(err).toContain('out of range');
    expect(err).toContain('2026-08-16');
  });

  it('rejects impossible months, days, hours, minutes', () => {
    expect(validateCalendarDates('2026-13-01', undefined, undefined, now)).toContain('invalid month');
    expect(validateCalendarDates('2026-02-30', undefined, undefined, now)).toContain('invalid day');
    expect(validateCalendarDates('2026-08-17T25:00', undefined, undefined, now)).toContain('invalid hour');
    expect(validateCalendarDates('2026-08-17T14:61', undefined, undefined, now)).toContain('invalid minute');
  });

  it('requires all-day events to be date-only', () => {
    expect(validateCalendarDates('2026-08-17T14:00', undefined, true, now)).toContain('date only');
  });

  it('rejects an end at or before the start', () => {
    expect(validateCalendarDates('2026-08-17T15:00', '2026-08-17T15:00', false, now)).toContain(
      'after the start',
    );
    expect(validateCalendarDates('2026-08-17T15:00', '2026-08-17T14:00', false, now)).toContain(
      'after the start',
    );
  });

  it('surfaces date errors from buildIntentUrl', () => {
    const res = buildIntentUrl('calendar_event', { title: 'X', start: '2026-13-01' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('calendar_event:');
  });
});

describe('buildIntentUrl email', () => {
  it('builds a mailto: URL with subject and body', () => {
    const res = buildIntentUrl('email', {
      recipient: 'sarah@example.com',
      subject: 'Q3 numbers',
      body: 'Here are the numbers.',
    });
    expect(res).toMatchObject({ ok: true, label: 'Opening email to sarah@example.com' });
    if (res.ok) {
      expect(res.url.startsWith('mailto:')).toBe(true);
      const qs = new URLSearchParams(res.url.slice(res.url.indexOf('?') + 1));
      expect(qs.get('subject')).toBe('Q3 numbers');
      expect(qs.get('body')).toBe('Here are the numbers.');
    }
  });

  it('rejects an invalid recipient', () => {
    const res = buildIntentUrl('email', { recipient: 'not-an-email' });
    expect(res.ok).toBe(false);
  });

  it('requires a recipient', () => {
    const res = buildIntentUrl('email', { subject: 'Hi' });
    expect(res).toMatchObject({ ok: false, error: 'email requires a "recipient".' });
  });
});

describe('buildIntentUrl map intents', () => {
  it('builds maps directions', () => {
    const res = buildIntentUrl('map_directions', {
      destination: 'Central Park',
      origin: 'Home',
    });
    expect(res).toMatchObject({ ok: true, label: 'Opening directions to Central Park' });
    if (res.ok) {
      const url = new URL(res.url);
      expect(url.hostname).toBe('www.google.com');
      expect(url.pathname).toBe('/maps/dir/');
      expect(url.searchParams.get('api')).toBe('1');
      expect(url.searchParams.get('destination')).toBe('Central Park');
      expect(url.searchParams.get('origin')).toBe('Home');
    }
  });

  it('requires a destination', () => {
    const res = buildIntentUrl('map_directions', {});
    expect(res).toMatchObject({
      ok: false,
      error: 'map_directions requires a "destination".',
    });
  });

  it('builds a maps search URL with escaping', () => {
    const res = buildIntentUrl('map_search', { query: 'coffee & bagels near me' });
    expect(res).toMatchObject({ ok: true, label: 'Searching maps for coffee & bagels near me' });
    if (res.ok) {
      expect(res.url).toContain('/maps/search/');
      expect(res.url).toContain(encodeURIComponent('coffee & bagels near me'));
    }
  });

  it('requires a search query', () => {
    const res = buildIntentUrl('map_search', {});
    expect(res).toMatchObject({ ok: false, error: 'map_search requires a "query".' });
  });
});

describe('buildIntentUrl call_whatsapp', () => {
  it('builds a wa.me link from a formatted phone number', () => {
    const res = buildIntentUrl('call_whatsapp', {
      phone: '+1 (555) 010-0199',
      message: 'Meeting moved',
    });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.url).toBe(
        'https://wa.me/15550100199?text=' + encodeURIComponent('Meeting moved'),
      );
    }
  });

  it('rejects an invalid phone number', () => {
    const res = buildIntentUrl('call_whatsapp', { phone: 'abc' });
    expect(res).toMatchObject({ ok: false, error: '"abc" is not a valid phone number.' });
  });

  it('requires a phone number', () => {
    const res = buildIntentUrl('call_whatsapp', {});
    expect(res).toMatchObject({ ok: false, error: 'call_whatsapp requires a "phone".' });
  });
});

describe('validators', () => {
  it('validates emails loosely but rejects garbage', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.com')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
  });

  it('validates international phone numbers', () => {
    expect(isValidPhone('+91 98765 43210')).toBe(true);
    expect(isValidPhone('(555) 010-0199')).toBe(true);
    expect(isValidPhone('1234567890')).toBe(true);
    expect(isValidPhone('abc')).toBe(false);
    expect(isValidPhone('12')).toBe(false);
  });

  it('recognizes only the known intent hosts', () => {
    expect(isValidIntentHost('calendar.google.com')).toBe(true);
    expect(isValidIntentHost('outlook.live.com')).toBe(true);
    expect(isValidIntentHost('www.google.com')).toBe(true);
    expect(isValidIntentHost('evil.example.com')).toBe(false);
  });
});
