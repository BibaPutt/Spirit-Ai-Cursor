import type { SpiritDemo } from '../lib/spirit';
import { SUGGESTION_CHIPS } from './demo';

// Doc-native demos: the docs never show screenshots — where a picture would
// go, the real Spirit UI components render (same sbox/sann CSS as the app,
// ported 1:1 and already used by the landing page).

export const DOC_BOX_DEMO: SpiritDemo = {
  id: 'doc-release-script',
  prompt: 'What does the release script do?',
  file: 'scripts/release.mjs',
  chips: SUGGESTION_CHIPS,
  steps: ['Reading scripts/release.mjs', 'Tracing npm run gate', 'Summarizing the pipeline'],
  blocks: [
    {
      type: 'p',
      text: 'It bumps the version, runs the full gate, then shells into electron-builder per platform.',
    },
    {
      type: 'kpis',
      items: [
        { label: 'Gate', value: 'typecheck + tests' },
        { label: 'Targets', value: '3 platforms' },
        { label: 'Signing', value: 'env-gated', delta: 'no secrets in repo' },
      ],
    },
    {
      type: 'note',
      text: 'Nothing publishes unless the gate exits 0 — the same rule the docs describe below.',
    },
  ],
  followups: ['Show the NSIS config', 'How is signing toggled?'],
  rail: [
    { label: 'Open the script', icon: 'point' },
    { label: 'Copy', icon: 'copy' },
  ],
  elapsedSecs: 1.9,
};

export const DOC_ANNOTATE_DEMO: SpiritDemo = {
  id: 'doc-annotate-export',
  prompt: 'Where do I export this?',
  file: 'invoice-042.pdf',
  chips: SUGGESTION_CHIPS,
  steps: ['Reading the toolbar', 'Locating the export action'],
  blocks: [
    { type: 'p', text: 'The export button is in the toolbar, top right.' },
    { type: 'annot', n: 1, text: 'Export — opens the save dialog' },
    {
      type: 'note',
      text: 'The model emitted [POINT]/[BOX] tags in image space; the overlay maps them onto your real screen.',
    },
  ],
  rail: [{ label: 'Point at it', icon: 'point' }],
  annotations: [
    { kind: 'arrow', target: 'docdemo-export', label: 'Export', n: 1 },
    { kind: 'box', target: 'docdemo-total', label: 'Total row', n: 2 },
  ],
  elapsedSecs: 1.4,
};
