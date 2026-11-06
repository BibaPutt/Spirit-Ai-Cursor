// Google's public favicon service: `https://<host>/favicon.ico` is unreliable
// (missing favicons, wrong formats), this always resolves. Returns '' for
// unparseable URLs so callers can fall back to an icon.
export function faviconUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (!host) return '';
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  } catch {
    return '';
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
