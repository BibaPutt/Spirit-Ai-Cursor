// Reconcile a captured URL against the LIVE active-tab label.
//
// Arc (and some Chromium builds) freeze their UIA Document/address-bar value
// at the FIRST tab opened after launch — switching tabs never refreshes it,
// only restarting the browser does. And when the Spirit overlay covers the
// browser, the covered renderer can drop its Document value entirely, so the
// URL walk often returns EMPTY while the tab strip label is still live. The
// live signal that DOES track tab switches is the label of the current tab in
// the tab strip. This module merges the two:
//  - the label always wins for `title` (the window title is just "Arc" and
//    the stale Document name belongs to a page the user isn't on);
//  - when the label is host-shaped (bare domain / "localhost" / IPv4), it IS
//    the address: if the captured URL's host disagrees (stale tab) the URL is
//    rewritten to the label's host, and if NO URL was captured at all
//    (occluded window) a host-level URL is synthesized so the chip still shows
//    where the user is instead of just the app name.
// Chrome/Edge/Firefox are unaffected: their UIA URLs match the current tab,
// so the host comparison agrees and nothing is rewritten.

import type { AppContext } from '../types';

// True for labels that look like a hostname: a bare domain ("instagram.com"),
// "localhost", or an IPv4 literal. Page titles like "Sample App — A Page
// Title" or "Google Search" are NOT host-shaped and never
// trigger a URL rewrite (Chrome tabs are titled "Google Search" while the
// URL is google.com/search — rewriting there would corrupt a good URL).
export function isHostLikeLabel(label: string): boolean {
  const s = label.trim().toLowerCase();
  if (s === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s);
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Mutates `ctx` in place: title ← live label; url ← host-level rewrite (or a
// host-level synthesis when no URL was captured at all) whenever the label
// proves the captured URL belongs to a different tab.
export function reconcileActiveTab(ctx: AppContext): void {
  const label = ctx.activeTab?.trim();
  if (!label) return;
  if (label !== ctx.title) ctx.title = label;
  if (!isHostLikeLabel(label)) return;
  const labelHost = label.toLowerCase().replace(/^www\./, '');
  const host = hostnameFromUrl(ctx.url ?? '');
  if (host === labelHost) return;
  ctx.url = `https://${labelHost}/`;
}
