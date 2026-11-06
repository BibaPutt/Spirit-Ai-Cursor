import termsMd from '../../../TERMS.md?raw';
import privacyMd from '../../../PRIVACY.md?raw';
import creditsMd from '../../../CREDITS.md?raw';
import licenseMd from '../../../LICENSE?raw';
import { markdownToHtml } from '../lib/markdown';

// The legal documents are imported raw from the repository root — the same
// canonical files that ship inside the desktop app's asar and render in its
// in-app Legal window. The site never carries its own fork of the text.
// The leading `# Title` line is dropped: the section heading comes from the
// page chrome (localized) instead.

function dropTitle(md: string): string {
  return md.replace(/^#\s+.*\n/, '');
}

export type LegalDoc = {
  id: 'terms' | 'privacy' | 'credits' | 'license';
  titleKey: string;
  tocKey: string;
  html: string;
};

export const LEGAL_DOCS: LegalDoc[] = [
  { id: 'terms', titleKey: 'legal.doc.terms', tocKey: 'legal.toc.terms', html: markdownToHtml(dropTitle(termsMd)) },
  { id: 'privacy', titleKey: 'legal.doc.privacy', tocKey: 'legal.toc.privacy', html: markdownToHtml(dropTitle(privacyMd)) },
  { id: 'credits', titleKey: 'legal.doc.credits', tocKey: 'legal.toc.credits', html: markdownToHtml(dropTitle(creditsMd)) },
  { id: 'license', titleKey: 'legal.doc.license', tocKey: 'legal.toc.license', html: markdownToHtml(dropTitle(licenseMd)) },
];
