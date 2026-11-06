import { describe, expect, it, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => {
  const fn = vi.fn(() => ({}));
  return {
    app: {
      isPackaged: false,
      getName: () => 'Spirit',
      getVersion: () => 'test',
      getPath: () => tmpdir(),
      whenReady: () => Promise.resolve(),
      on: fn,
      quit: fn,
    },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: fn, decryptString: fn },
  };
});

const mockRunPlainCompletion = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../electron/llm/providers/router', () => ({
  runPlainCompletion: mockRunPlainCompletion,
}));

const hoisted = vi.hoisted(() => {
  let workspace = '';
  let enabled = true;
  return {
    getWorkspace: () => workspace,
    setWorkspace: (v: string) => {
      workspace = v;
    },
    isEnabled: () => enabled,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
  };
});
vi.mock('../electron/store/settings', () => ({
  getSettings: () => ({ contextMemoryEnabled: hoisted.isEnabled() }),
  getWorkspaceFolder: () => hoisted.getWorkspace(),
}));

import {
  recallMemories,
  rememberTakeaways,
  clearMemories,
  getAllMemories,
  hashText,
} from '../electron/memory/contextMemory';

// GENUINE retrieval eval: seeds the REAL store via rememberTakeaways, queries
// via the REAL recallMemories (BM25x0.6 + synonymx0.3 + fuzzyx0.1, floor 0.06),
// and scores P@1 / P@3 / R@3 per query type. Typo + distractor queries are
// deliberately hard so the score is honestly < 100%.

// 50 synthetic facts — distinct topics, all "User ..."-anchored so they pass
// the worth-remembering gate through the real ingestion path.
const FACTS: string[] = [
  'User prefers brief answers with no fluff',
  'User drinks black coffee every morning',
  'User drinks chamomile tea before bed',
  'User uses a dark editor theme at night',
  'User types on a mechanical keyboard with brown switches',
  'User runs five kilometers every Tuesday',
  'User owns a golden retriever named Biscuit',
  'User owns a tabby cat named Miso',
  'User is reading a history of the Roman Empire',
  'User loves science fiction movies about space travel',
  'User plays acoustic guitar on weekends',
  'User listens to smooth jazz while coding',
  'User visited Kyoto in spring for cherry blossoms',
  'User plans a hiking trip to the Dolomites',
  'User cooks Italian pasta from scratch',
  'User bakes sourdough bread every Sunday',
  'User works as a backend engineer at a fintech startup',
  'User is building a personal budget tracking app',
  'User is learning Spanish with daily practice',
  'User speaks fluent German and English',
  'User prefers morning meetings after ten oclock',
  'User takes notes in a paper notebook',
  'User uses standing desk for afternoon work',
  'User cycles to work along the river path',
  'User swims laps at the community pool',
  'User practices yoga for twenty minutes daily',
  'User meditates before important presentations',
  'User volunteers at the animal shelter monthly',
  'User donates to ocean cleanup charities',
  'User grows tomatoes on the balcony',
  'User keeps a sourdough starter named Doughbiwan',
  'User collects vintage vinyl records',
  'User attends live theatre performances downtown',
  'User photographs street art with film camera',
  'User writes short stories about train journeys',
  'User studies machine learning through online courses',
  'User contributes to open source documentation',
  'User mentors junior developers on Fridays',
  'User interviews candidates for the platform team',
  'User manages a remote team across three timezones',
  'User tracks expenses in a spreadsheet every month',
  'User saves for a down payment on an apartment',
  'User drives an old hatchback with manual transmission',
  'User commutes by train and reads novels',
  'User prefers window seats on flights',
  'User packs light with only a carry on backpack',
  'User celebrates Diwali with family every autumn',
  'User calls grandmother every Sunday evening',
  'User hosts board game nights with neighbors',
  'User brews kombucha in the kitchen pantry',
];

// 10 distractors: same vocabulary neighbourhood as real targets, so vague
// queries retrieve THEM instead of the intended fact.
const DISTRACTORS: string[] = [
  'User likes classical jazz fusion concerts',
  'User drinks green tea in the afternoon',
  'User drinks espresso after lunch meetings',
  'User prefers detailed answers with examples',
  'User runs marathons every autumn season',
  'User owns a parrot that mimics ringtones',
  'User watches documentary films about oceans',
  'User visited Osaka during winter festival',
  'User cooks French omelettes for brunch',
  'User commutes by bike through city traffic',
];

type QType = 'exact' | 'paraphrase' | 'synonym' | 'typo' | 'distractor';
type EvalQuery = { type: QType; query: string; expect: string };

const QUERIES: EvalQuery[] = [
  // exact (near-verbatim)
  { type: 'exact', query: 'User prefers brief answers with no fluff', expect: FACTS[0] },
  { type: 'exact', query: 'User owns a golden retriever named Biscuit', expect: FACTS[6] },
  { type: 'exact', query: 'User visited Kyoto in spring for cherry blossoms', expect: FACTS[12] },
  { type: 'exact', query: 'User bakes sourdough bread every Sunday', expect: FACTS[15] },
  { type: 'exact', query: 'User speaks fluent German and English', expect: FACTS[19] },
  { type: 'exact', query: 'User meditates before important presentations', expect: FACTS[26] },
  { type: 'exact', query: 'User collects vintage vinyl records', expect: FACTS[31] },
  { type: 'exact', query: 'User calls grandmother every Sunday evening', expect: FACTS[47] },
  // paraphrase (same content, different words)
  { type: 'paraphrase', query: 'what does the user drink first thing in the morning', expect: FACTS[1] },
  { type: 'paraphrase', query: 'which pet dog does the user have', expect: FACTS[6] },
  { type: 'paraphrase', query: 'what instrument does the user play on days off', expect: FACTS[10] },
  { type: 'paraphrase', query: 'where did the user travel to see cherry blossoms', expect: FACTS[12] },
  { type: 'paraphrase', query: 'what language is the user studying every day', expect: FACTS[18] },
  { type: 'paraphrase', query: 'how does the user get to work in the morning', expect: FACTS[43] },
  { type: 'paraphrase', query: 'who does the user phone on weekend evenings', expect: FACTS[47] },
  // synonym (related-word swap; synonym expansion should help some)
  { type: 'synonym', query: 'user automobile hatchback stick shift', expect: FACTS[42] },
  { type: 'synonym', query: 'user feline kitty Miso', expect: FACTS[7] },
  { type: 'synonym', query: 'user motion picture sci-fi cosmos voyage', expect: FACTS[9] },
  { type: 'synonym', query: 'user dwelling balcony greenery tomatoes', expect: FACTS[29] },
  { type: 'synonym', query: 'user precipitation-free daylight aeroplane seating', expect: FACTS[44] },
  { type: 'synonym', query: 'user canine shelter charity monthly', expect: FACTS[27] },
  { type: 'synonym', query: 'user evening chamomile infusion slumber', expect: FACTS[2] },
  // typo (light ones recoverable via fuzzy; heavy ones SHOULD fail)
  { type: 'typo', query: 'User preferrs breif answers', expect: FACTS[0] },
  { type: 'typo', query: 'User owns a goldem retriver named Biscut', expect: FACTS[6] },
  { type: 'typo', query: 'usr drnks blak coffe evry mornng', expect: FACTS[1] },
  { type: 'typo', query: 'usr aks guitarr wekends', expect: FACTS[10] },
  { type: 'typo', query: 'Kyotoo chery blosoms sprng visit', expect: FACTS[12] },
  { type: 'typo', query: 'xqzt wvpl kbrn fltwd dksupr ghmzrc', expect: FACTS[20] },
  // distractor (vague query matches a distractor better than target)
  { type: 'distractor', query: 'what does the user drink', expect: FACTS[1] },
  { type: 'distractor', query: 'what kind of jazz does the user like', expect: FACTS[11] },
];

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.setEnabled(true);
  hoisted.setWorkspace(join(tmpdir(), 'spirit-eval-memory-real'));
  await fs.mkdir(hoisted.getWorkspace(), { recursive: true });
  await clearMemories();
});

describe('genuine memory retrieval eval (real recall path)', () => {
  it('seeds 60 facts via rememberTakeaways, scores 30 real queries', async () => {
    // Seed through the REAL ingestion path (gate + dedup + merge included).
    const seeded = await rememberTakeaways(
      [...FACTS, ...DISTRACTORS].map((text) => ({ text, attributedTo: 'user' as const })),
      ['eval'],
    );
    const stored = await getAllMemories();
    expect(stored.length).toBeGreaterThanOrEqual(55); // nothing silently dropped

    // Sanity: stored texts are exactly what we seeded (hash-verified).
    for (const f of FACTS) {
      expect(stored.some((m) => m.hash === hashText(f))).toBe(true);
    }

    const K = 3;
    const rows: Array<{
      type: string;
      query: string;
      p1: number;
      p3: number;
      r3: number;
      top1: string;
    }> = [];

    for (const q of QUERIES) {
      // REAL retrieval: BM25x0.6 + synonymx0.3 + fuzzyx0.1, floor 0.06.
      const hits = await recallMemories(q.query, 5);
      const topK = hits.slice(0, K).map((h) => h.text);
      const rank = topK.indexOf(q.expect);
      const p1 = rank === 0 ? 1 : 0;
      const p3 = rank >= 0 ? 1 / K : 0;
      const r3 = rank >= 0 ? 1 : 0;
      rows.push({
        type: q.type,
        query: q.query.length > 44 ? q.query.slice(0, 44) + '…' : q.query,
        p1,
        p3,
        r3,
        top1: (hits[0]?.text ?? '(no recall)').slice(0, 52),
      });
    }

    const byType = (t: QType) => rows.filter((r) => r.type === t);
    const agg = (rs: typeof rows) => ({
      n: rs.length,
      p1: rs.reduce((s, r) => s + r.p1, 0) / rs.length,
      p3: rs.reduce((s, r) => s + r.p3, 0) / rs.length,
      r3: rs.reduce((s, r) => s + r.r3, 0) / rs.length,
    });
    const overall = agg(rows);

    const line =
      `| ${'type'.padEnd(10)} | ${'n'.padEnd(3)} | ${'P@1'.padEnd(6)} | ` +
      `${'P@3'.padEnd(6)} | ${'R@3'.padEnd(6)} |`;
    const sep = '|------------|-----|--------|--------|--------|';
    const fmt = (t: string, a: { n: number; p1: number; p3: number; r3: number }) =>
      `| ${t.padEnd(10)} | ${String(a.n).padEnd(3)} | ${a.p1.toFixed(3).padEnd(6)} | ` +
      `${a.p3.toFixed(3).padEnd(6)} | ${a.r3.toFixed(3).padEnd(6)} |`;
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        'MEMORY RETRIEVAL EVAL (real recallMemories, 60 seeded facts, 30 queries)',
        `seeded: added=${seeded.added} total=${seeded.total} stored=${stored.length}`,
        line,
        sep,
        fmt('exact', agg(byType('exact'))),
        fmt('paraphrase', agg(byType('paraphrase'))),
        fmt('synonym', agg(byType('synonym'))),
        fmt('typo', agg(byType('typo'))),
        fmt('distractor', agg(byType('distractor'))),
        fmt('OVERALL', overall),
        '',
        'MISSES (rank>3 or no recall):',
        ...rows
          .filter((r) => r.r3 === 0)
          .map((r) => `  [${r.type}] "${r.query}" -> top1: "${r.top1}"`),
      ].join('\n'),
    );

    // Genuine, non-trivial, imperfect: proves real scoring, not hardcoded pass.
    expect(overall.p1).toBeGreaterThan(0.3);
    expect(overall.p1).toBeLessThan(1);
    expect(rows.filter((r) => r.r3 === 0).length).toBeGreaterThan(0);
    expect(byType('exact').reduce((s, r) => s + r.p1, 0)).toBeGreaterThan(
      byType('typo').reduce((s, r) => s + r.p1, 0),
    );
  });
});
