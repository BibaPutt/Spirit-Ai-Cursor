import type { SpiritDemo, SpiritSuggestionChip } from '../lib/spirit';

export const SUGGESTION_CHIPS: SpiritSuggestionChip[] = [
  { label: 'Summarize this document', icon: 'list' },
  { label: 'Extract the key points', icon: 'list' },
  { label: 'List the data', icon: 'table' },
];

export const HERO_DEMO: SpiritDemo = {
  id: 'hero-region',
  prompt: 'Which region grew fastest?',
  file: 'Q3-revenue.pdf',
  chips: SUGGESTION_CHIPS,
  steps: ['Reading Q3-revenue.pdf', 'Comparing YoY by region', 'Checking table row 3'],
  blocks: [
    { type: 'p', text: 'Asia Pacific, at 21% year over year. It is also the smallest region on the page.' },
    {
      type: 'chart',
      rows: [
        { label: 'Asia Pacific', value: 21, display: '+21%', hi: true },
        { label: 'North America', value: 12, display: '+12%' },
        { label: 'Europe', value: 9, display: '+9%' },
        { label: 'Latin America', value: 4, display: '+4%' },
      ],
    },
    {
      type: 'kpis',
      items: [
        { label: 'Revenue', value: '$986k', delta: 'smallest' },
        { label: 'YoY', value: '+21%', delta: 'fastest' },
      ],
    },
  ],
  followups: ['Point at the row', 'Compare to Q2'],
  rail: [
    { label: 'Point at the row', icon: 'point' },
    { label: 'Copy', icon: 'copy' },
  ],
  annotations: [
    { kind: 'box', target: 'apac', label: 'Asia Pacific', n: 1 },
    { kind: 'chip', target: 'apac', label: '+21% YoY', n: 1 },
  ],
  elapsedSecs: 2.2,
};

export const INVOICE_DEMO: SpiritDemo = {
  id: 'invoice-row',
  prompt: 'Which row should I fix?',
  file: 'invoice-042.pdf',
  chips: SUGGESTION_CHIPS,
  steps: ['Opening invoice-042.pdf', 'Scanning totals', 'Comparing column sums'],
  blocks: [
    { type: 'p', text: 'The March invoice, row 14. The total is pulling from the wrong column.' },
    { type: 'annot', n: 1, text: 'Row 14 · $4,280.00 pulled from the tax column' },
    {
      type: 'note',
      text: 'Row 14 sums the tax column into the subtotal. Re-point the formula at column C.',
    },
    {
      type: 'kpis',
      items: [
        { label: 'Row', value: '14' },
        { label: 'Shown', value: '$4,280', delta: 'wrong col' },
        { label: 'Should be', value: '$4,076' },
      ],
    },
  ],
  followups: ['Summarize this page', 'Compare to Q2'],
  rail: [
    { label: 'Point at the row', icon: 'point' },
    { label: 'Copy', icon: 'copy' },
  ],
  annotations: [{ kind: 'box', target: 'row-14', label: 'Row 14', n: 1 }],
  elapsedSecs: 1.8,
};

export const DIP_DEMO: SpiritDemo = {
  id: 'march-dip',
  prompt: 'Explain the dip in March',
  file: 'Q3-revenue.pdf',
  chips: SUGGESTION_CHIPS,
  steps: ['Reading chart series', 'Checking invoice dates', 'Looking at churn signals'],
  blocks: [
    {
      type: 'p',
      text: 'March is a billing timing change, not churn. Two invoices slipped into April, so the quarter closes 18% up.',
    },
    {
      type: 'chart',
      title: 'Monthly billed',
      rows: [
        { label: 'January', value: 78, display: '$78k' },
        { label: 'February', value: 92, display: '$92k' },
        { label: 'March', value: 61, display: '$61k', hi: true },
        { label: 'April', value: 88, display: '$88k' },
      ],
    },
    { type: 'latex', tex: 'r_{\\text{QoQ}} = \\frac{P_{\\text{end}} - P_{\\text{start}}}{P_{\\text{start}}} \\approx 0.18' },
  ],
  followups: ['Point at the chart', 'Save to notes'],
  rail: [
    { label: 'Point at the chart', icon: 'point' },
    { label: 'Save to notes', icon: 'save' },
  ],
  elapsedSecs: 2.4,
};

export const EXPORT_DEMO: SpiritDemo = {
  id: 'export-csv',
  prompt: 'Export this table as CSV',
  file: 'pipeline.csv',
  chips: SUGGESTION_CHIPS,
  steps: ['Locating table bounds', 'Reading 128 rows', 'Writing pipeline.csv'],
  blocks: [
    { type: 'p', text: 'Pipeline exported. 128 rows, header preserved.' },
    {
      type: 'acts',
      items: [
        { label: 'Click · Export' },
        { label: 'Wait for the save dialog' },
        { label: 'Done · pipeline.csv' },
      ],
    },
  ],
  followups: ['Open the file', 'Share the link'],
  rail: [{ label: 'Copy path', icon: 'copy' }],
  elapsedSecs: 1.4,
};

export const PREVIEW_QUESTIONS: SpiritDemo[] = [
  HERO_DEMO,
  INVOICE_DEMO,
  DIP_DEMO,
  {
    id: 'summarize',
    prompt: 'Summarize this page',
    steps: ['Extracting headings', 'Pulling key numbers', 'Drafting summary'],
    blocks: [
      {
        type: 'p',
        text: 'Q3 revenue by region: North America leads at $1.84M (+12%), Asia Pacific grows fastest at +21%. Full reconciliation sits in appendix B.',
      },
      {
        type: 'mermaid',
        code: 'flowchart LR\n  A[Screen] --> B[OCR + UI tree]\n  B --> C[Model]\n  C --> D[Answer in place]',
      },
    ],
    followups: ['Point at the table', 'Copy'],
    rail: [{ label: 'Copy', icon: 'copy' }],
    elapsedSecs: 2.0,
  },
  {
    id: 'compare-q2',
    prompt: 'Compare to Q2',
    steps: ['Loading Q2 baseline', 'Aligning regions', 'Computing deltas'],
    blocks: [
      { type: 'p', text: 'Q3 is up 18% overall versus Q2. Asia Pacific added the most absolute growth; Europe was flat.' },
      {
        type: 'kpis',
        items: [
          { label: 'QoQ', value: '+18%' },
          { label: 'Best', value: 'APAC', delta: '+21%' },
          { label: 'Flat', value: 'EU', delta: '0%' },
        ],
      },
    ],
    followups: ['Show the chart', 'Save to notes'],
    rail: [{ label: 'Save to notes', icon: 'save' }],
    elapsedSecs: 1.9,
  },
  EXPORT_DEMO,
];

function variant(base: SpiritDemo, id: string, prompt: string, patch: Partial<SpiritDemo> = {}): SpiritDemo {
  return { ...base, ...patch, id, prompt };
}

const COPY_DEMO: SpiritDemo = {
  id: 'copy-answer',
  prompt: 'Copy',
  steps: ['Selecting the answer', 'Writing to clipboard'],
  blocks: [
    { type: 'p', text: 'Copied. The answer is on your clipboard, ready to paste.' },
    { type: 'note', text: 'Spirit keeps the formatting when the target app accepts it.' },
  ],
  followups: ['Paste here', 'Save to notes'],
  rail: [{ label: 'Paste here', icon: 'copy' }],
  elapsedSecs: 0.7,
};

const NOTES_DEMO: SpiritDemo = {
  id: 'save-note',
  prompt: 'Save to notes',
  steps: ['Opening memory', 'Writing the note'],
  blocks: [
    { type: 'p', text: 'Saved to notes under Q3 revenue. You can recall it from the memory panel.' },
    {
      type: 'kpis',
      items: [
        { label: 'Notebook', value: 'Q3' },
        { label: 'Entries', value: '12' },
      ],
    },
  ],
  followups: ['Open notes', 'Summarize this page'],
  rail: [{ label: 'Open notes', icon: 'save' }],
  elapsedSecs: 0.9,
};

const LINK_DEMO: SpiritDemo = {
  id: 'share-link',
  prompt: 'Share the link',
  steps: ['Creating a read-only link', 'Copying to clipboard'],
  blocks: [
    { type: 'p', text: 'Link copied. Anyone with it can read this answer, nothing else.' },
    { type: 'note', text: 'spirit.app/s/7f3a-q2' },
  ],
  followups: ['Open the file', 'Copy path'],
  rail: [{ label: 'Copy', icon: 'copy' }],
  elapsedSecs: 0.8,
};

const SUMMARIZE_DEMO = PREVIEW_QUESTIONS[3]!;
const COMPARE_DEMO = PREVIEW_QUESTIONS[4]!;

const POINT_ROW_DEMO = variant(INVOICE_DEMO, 'chip-point-row', 'Point at the row');
const POINT_CHART_DEMO = variant(DIP_DEMO, 'chip-point-chart', 'Point at the chart');
const POINT_TABLE_DEMO = variant(HERO_DEMO, 'chip-point-table', 'Point at the table');
const SHOW_CHART_DEMO = variant(DIP_DEMO, 'chip-show-chart', 'Show the chart');
const OPEN_FILE_DEMO = variant(EXPORT_DEMO, 'chip-open-file', 'Open the file');
const COPY_PATH_DEMO = variant(EXPORT_DEMO, 'chip-copy-path', 'Copy path');

export const PREVIEW_CHIP_DEMOS: Record<string, SpiritDemo> = {
  'Summarize this document': variant(SUMMARIZE_DEMO, 'chip-summarize-document', 'Summarize this document'),
  'Extract the key points': variant(COMPARE_DEMO, 'chip-key-points', 'Extract the key points'),
  'List the data': variant(DIP_DEMO, 'chip-list-data', 'List the data'),
  'Summarize this page': variant(SUMMARIZE_DEMO, 'chip-summarize-page', 'Summarize this page'),
  'Compare to Q2': variant(COMPARE_DEMO, 'chip-compare-q2', 'Compare to Q2'),
  'Point at the row': POINT_ROW_DEMO,
  'Point at the chart': POINT_CHART_DEMO,
  'Point at the table': POINT_TABLE_DEMO,
  'Show the chart': SHOW_CHART_DEMO,
  'Save to notes': NOTES_DEMO,
  'Open notes': NOTES_DEMO,
  Copy: COPY_DEMO,
  'Paste here': COPY_DEMO,
  'Share the link': LINK_DEMO,
  'Open the file': OPEN_FILE_DEMO,
  'Copy path': COPY_PATH_DEMO,
};

export function resolvePreviewDemo(label: string, current: SpiritDemo): SpiritDemo {
  const known = PREVIEW_CHIP_DEMOS[label];
  if (known) return known;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { ...current, id: `${current.id}-${slug || 'followup'}`, prompt: label };
}

export const RAIL_CHIPS_DEFAULT = HERO_DEMO.rail ?? [];
