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
} from '../electron/memory/contextMemory';
import { verifyActionClaims } from '../electron/llm/claim-verify';
import {
  toolRoundFingerprint,
  nextIdenticalStallCount,
  isIdenticalStallHit,
  nextAllErrorStreak,
  isAllErrorStreakHit,
  nextBadInputStreak,
  isBadInputStreakHit,
  MAX_IDENTICAL_ROUNDS,
} from '../electron/llm/loop-guards';

// EXP-5+EXP-6 GENUINE: memory ON/OFF + verifier ON/OFF, all through REAL code.
// (a) memory: seed via rememberTakeaways, query via recallMemories with the
//     contextMemoryEnabled toggle ON vs OFF -> P@1/R@3 delta.
// (b) verifier: REAL verifyActionClaims on labeled answer logs (true vs false
//     claims) -> precision/recall + false-claim rate, ON vs OFF.
// (c) loop guards: REAL fingerprint/streak helpers on synthetic long traces ->
//     stall-trigger% + wasted-step reduction, ON vs OFF.

const FACTS: string[] = [
  'User prefers brief answers with no fluff',
  'User drinks black coffee every morning',
  'User drinks chamomile tea before bed',
  'User owns a golden retriever named Biscuit',
  'User owns a tabby cat named Miso',
  'User plays acoustic guitar on weekends',
  'User listens to smooth jazz while coding',
  'User visited Kyoto in spring for cherry blossoms',
  'User cooks Italian pasta from scratch',
  'User bakes sourdough bread every Sunday',
  'User works as a backend engineer at a fintech startup',
  'User is learning Spanish with daily practice',
  'User speaks fluent German and English',
  'User runs five kilometers every Tuesday',
  'User cycles to work along the river path',
  'User practices yoga for twenty minutes daily',
  'User meditates before important presentations',
  'User grows tomatoes on the balcony',
  'User collects vintage vinyl records',
  'User calls grandmother every Sunday evening',
  'User hosts board game nights with neighbors',
  'User brews kombucha in the kitchen pantry',
  'User drives an old hatchback with manual transmission',
  'User celebrates Diwali with family every autumn',
];

const DISTRACTORS: string[] = [
  'User likes classical jazz fusion concerts',
  'User drinks green tea in the afternoon',
  'User prefers detailed answers with examples',
  'User owns a parrot that mimics ringtones',
  'User visited Osaka during winter festival',
  'User cooks French omelettes for brunch',
];

type QType = 'exact' | 'paraphrase' | 'typo' | 'distractor';
type EvalQuery = { type: QType; query: string; expect: string };

const QUERIES: EvalQuery[] = [
  { type: 'exact', query: 'User owns a golden retriever named Biscuit', expect: FACTS[3] },
  { type: 'exact', query: 'User visited Kyoto in spring for cherry blossoms', expect: FACTS[7] },
  { type: 'exact', query: 'User speaks fluent German and English', expect: FACTS[12] },
  { type: 'exact', query: 'User calls grandmother every Sunday evening', expect: FACTS[19] },
  { type: 'paraphrase', query: 'what does the user drink first thing in the morning', expect: FACTS[1] },
  { type: 'paraphrase', query: 'which pet dog does the user have', expect: FACTS[3] },
  { type: 'paraphrase', query: 'what instrument does the user play on days off', expect: FACTS[5] },
  { type: 'paraphrase', query: 'who does the user phone on weekend evenings', expect: FACTS[19] },
  { type: 'typo', query: 'User owns a goldem retriver named Biscut', expect: FACTS[3] },
  { type: 'typo', query: 'usr drnks blak coffe evry mornng', expect: FACTS[1] },
  { type: 'typo', query: 'xqzt wvpl kbrn fltwd dksupr ghmzrc', expect: FACTS[10] },
  { type: 'distractor', query: 'what does the user drink', expect: FACTS[1] },
  { type: 'distractor', query: 'what kind of jazz does the user like', expect: FACTS[6] },
];

// Labeled answer log: label=true means the answer's action claim is FALSE
// (unsupported by the run's tools) and SHOULD be flagged.
type ClaimCase = {
  answer: string;
  executedTools: string[];
  hasMutatingAction: boolean;
  falseClaim: boolean;
  note: string;
};

const CLAIM_CASES: ClaimCase[] = [
  { answer: 'Done. I clicked the download button and it worked.', executedTools: [], hasMutatingAction: false, falseClaim: true, note: 'click, no action ran' },
  { answer: "I've typed your name into the box.", executedTools: [], hasMutatingAction: false, falseClaim: true, note: 'typed, no action ran' },
  { answer: 'I already downloaded the file for you.', executedTools: ['see_screen'], hasMutatingAction: false, falseClaim: true, note: 'download, read-only only' },
  { answer: 'I pasted the table into your document.', executedTools: ['ui_click'], hasMutatingAction: true, falseClaim: true, note: 'pasted but only a click ran' },
  { answer: 'I created the report file.', executedTools: ['ui_click', 'see_screen'], hasMutatingAction: true, falseClaim: true, note: 'created but no writer ran' },
  { answer: 'I copied the link to your clipboard.', executedTools: ['type_text'], hasMutatingAction: true, falseClaim: true, note: 'copied but only typing ran' },
  { answer: 'Done. I clicked the download button.', executedTools: ['ui_click'], hasMutatingAction: true, falseClaim: false, note: 'click backed by click' },
  { answer: 'Done. I clicked Save for you.', executedTools: ['press_key'], hasMutatingAction: true, falseClaim: false, note: 'mouse verb, mutating ran' },
  { answer: "I've typed your name into the box.", executedTools: ['type_text'], hasMutatingAction: true, falseClaim: false, note: 'typed backed by type_text' },
  { answer: 'I pasted the table into your document.', executedTools: ['paste_table'], hasMutatingAction: true, falseClaim: false, note: 'pasted backed by paste' },
  { answer: 'I created the report file.', executedTools: ['create_file'], hasMutatingAction: true, falseClaim: false, note: 'created backed by writer' },
  { answer: 'Here are the results you asked for.', executedTools: [], hasMutatingAction: false, falseClaim: false, note: 'no claim at all' },
  { answer: 'I will click the button now.', executedTools: [], hasMutatingAction: false, falseClaim: false, note: 'plan, not a claim' },
  { answer: "I didn't click anything yet.", executedTools: [], hasMutatingAction: false, falseClaim: false, note: 'negated, not a claim' },
  // Genuine blind spots (documented conservative tradeoffs — SHOULD miss):
  { answer: 'I sent the invoice to finance.', executedTools: [], hasMutatingAction: false, falseClaim: true, note: "'sent' has no tool mapping — verifier blind spot" },
  { answer: 'I built the quarterly deck this morning.', executedTools: ['ui_click'], hasMutatingAction: true, falseClaim: true, note: "'built' satisfied by ANY mutating action (conservative mouse-verb rule)" },
];

// Synthetic long traces: 8 tool rounds each. Looping traces repeat the same
// round; healthy traces vary every round. Some traces are all-error runs.
type SynthTrace = {
  kind: 'identical-loop' | 'all-error' | 'bad-input' | 'healthy';
  rounds: Array<{ calls: Array<{ name: string; args: Record<string, unknown> }>; executed: number; failed: number; badInput: number }>;
};

function buildTraces(): SynthTrace[] {
  const traces: SynthTrace[] = [];
  const clickRound = () => ({
    calls: [{ name: 'ui_click', args: { id: 7 } }],
    executed: 1,
    failed: 0,
    badInput: 0,
  });
  // 4 identical-loop traces (repeat-after-success stall)
  for (let i = 0; i < 4; i++) {
    traces.push({ kind: 'identical-loop', rounds: Array.from({ length: 8 }, clickRound) });
  }
  // 2 all-error traces (every call fails every round)
  for (let i = 0; i < 2; i++) {
    traces.push({
      kind: 'all-error',
      rounds: Array.from({ length: 8 }, (_, r) => ({
        calls: [{ name: 'ui_click', args: { id: r } }],
        executed: 1,
        failed: 1,
        badInput: 0,
      })),
    });
  }
  // 2 bad-input traces (whole round unparseable, nothing executes)
  for (let i = 0; i < 2; i++) {
    traces.push({
      kind: 'bad-input',
      rounds: Array.from({ length: 8 }, () => ({
        calls: [{ name: 'ui_click', args: {} }],
        executed: 0,
        failed: 0,
        badInput: 1,
      })),
    });
  }
  // 4 healthy traces (genuinely different step each round, all succeed)
  for (let i = 0; i < 4; i++) {
    const tools = ['see_screen', 'ui_read', 'ui_click', 'type_text', 'press_key', 'see_screen', 'ui_read', 'save_document'];
    traces.push({
      kind: 'healthy',
      rounds: tools.map((name, r) => ({
        calls: [{ name, args: { step: r, run: i } }],
        executed: 1,
        failed: 0,
        badInput: 0,
      })),
    });
  }
  return traces;
}

// Simulate the REAL router guard path over a trace: returns the round index
// (1-based) where the guard first trips (corrective nudge), or -1.
// Mirrors router.ts: trip -> ONE corrective round -> forced final.
function guardTripRound(t: SynthTrace): number {
  let identical = 0;
  let lastFp: string | null = null;
  let allErr = 0;
  let badIn = 0;
  for (let i = 0; i < t.rounds.length; i++) {
    const r = t.rounds[i];
    const fp = toolRoundFingerprint(r.calls);
    identical = nextIdenticalStallCount(identical, fp, lastFp);
    lastFp = fp;
    allErr = nextAllErrorStreak(allErr, r.calls.length, r.executed, r.failed);
    badIn = nextBadInputStreak(badIn, r.calls.length, r.badInput, r.executed);
    if (isIdenticalStallHit(identical) || isAllErrorStreakHit(allErr) || isBadInputStreakHit(badIn)) {
      return i + 1;
    }
  }
  return -1;
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.setEnabled(true);
  hoisted.setWorkspace(join(tmpdir(), 'spirit-eval-mem-verifier'));
  await fs.mkdir(hoisted.getWorkspace(), { recursive: true });
  await clearMemories();
});

describe('EXP-5+EXP-6 genuine: memory ON/OFF + verifier ON/OFF', () => {
  it('memory ON vs OFF delta + verifier ON vs OFF + loop-guard stall stats', async () => {
    // (a) MEMORY ON vs OFF
    const seeded = await rememberTakeaways(
      [...FACTS, ...DISTRACTORS].map((text) => ({ text, attributedTo: 'user' as const })),
      ['eval'],
    );
    const stored = await getAllMemories();
    expect(stored.length).toBeGreaterThanOrEqual(25);

    const scorePass = async () => {
      let p1hits = 0;
      let r3hits = 0;
      const misses: string[] = [];
      for (const q of QUERIES) {
        const hits = await recallMemories(q.query, 5);
        const top3 = hits.slice(0, 3).map((h) => h.text);
        if (top3[0] === q.expect) p1hits++;
        if (top3.includes(q.expect)) r3hits++;
        else misses.push(`[${q.type}] "${q.query}" -> top1: "${(hits[0]?.text ?? '(no recall)').slice(0, 48)}"`);
      }
      return {
        p1: p1hits / QUERIES.length,
        r3: r3hits / QUERIES.length,
        misses,
      };
    };

    hoisted.setEnabled(true);
    const on = await scorePass();
    hoisted.setEnabled(false); // REAL toggle: recallMemories short-circuits to []
    const off = await scorePass();
    hoisted.setEnabled(true);

    // (b) VERIFIER ON vs OFF on labeled answer log
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const verifierMisses: string[] = [];
    for (const c of CLAIM_CASES) {
      const fix = verifyActionClaims(c.answer, {
        executedTools: new Set(c.executedTools),
        hasMutatingAction: c.hasMutatingAction,
      });
      const flagged = fix !== null; // verifier ON verdict
      if (c.falseClaim && flagged) tp++;
      else if (!c.falseClaim && flagged) {
        fp++;
        verifierMisses.push(`FP "${c.note}": flagged "${c.answer.slice(0, 44)}"`);
      } else if (c.falseClaim && !flagged) {
        fn++;
        verifierMisses.push(`FN "${c.note}": missed "${c.answer.slice(0, 44)}"`);
      } else tn++;
    }
    const precisionOn = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recallOn = tp + fn === 0 ? 1 : tp / (tp + fn);
    const nFalse = CLAIM_CASES.filter((c) => c.falseClaim).length;
    // Verifier OFF = accept everything: no flags -> recall 0, all false claims pass.
    const recallOff = 0;
    const falseClaimRateOff = 1; // 100% of false claims sail through unflagged
    const falseClaimRateOn = fn / nFalse;

    // (c) LOOP GUARDS on synthetic long traces
    const traces = buildTraces();
    let stallTrips = 0;
    let wastedOff = 0; // total rounds burned with guards OFF (full 8 each)
    let wastedOn = 0; // rounds burned with guards ON (stop at trip+1 corrective)
    const stallMisses: string[] = [];
    for (const t of traces) {
      const trip = guardTripRound(t);
      wastedOff += t.rounds.length;
      if (t.kind === 'healthy') {
        if (trip !== -1) {
          stallTrips++;
          stallMisses.push(`FP healthy trace tripped at round ${trip}`);
        }
        wastedOn += t.rounds.length;
      } else {
        if (trip !== -1) {
          stallTrips++;
          // ONE corrective round after the trip, then forced final.
          wastedOn += Math.min(trip + 1, t.rounds.length);
        } else {
          wastedOn += t.rounds.length;
          stallMisses.push(`FN ${t.kind} trace never tripped`);
        }
      }
    }
    const stallTriggerPct = (stallTrips / traces.length) * 100;
    const loopingTrips = traces.filter((t) => t.kind !== 'healthy' && guardTripRound(t) !== -1).length;
    const loopingTotal = traces.filter((t) => t.kind !== 'healthy').length;
    const wastedSaved = wastedOff - wastedOn;
    const wastedSavedPct = (wastedSaved / wastedOff) * 100;

    // print 2 tables
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `TABLE 1 — MEMORY ON vs OFF (real recallMemories, ${stored.length} seeded facts, ${QUERIES.length} queries; seeded added=${seeded.added} total=${seeded.total})`,
        '| mode | P@1   | R@3   |',
        '|------|-------|-------|',
        `| ON   | ${on.p1.toFixed(3)} | ${on.r3.toFixed(3)} |`,
        `| OFF  | ${off.p1.toFixed(3)} | ${off.r3.toFixed(3)} |`,
        `| Δ    | ${(on.p1 - off.p1).toFixed(3)} | ${(on.r3 - off.r3).toFixed(3)} |`,
        '',
        'MISSES (ON, rank>3 or no recall):',
        ...on.misses.map((m) => `  ${m}`),
        '',
        `TABLE 2 — VERIFIER ON vs OFF (${CLAIM_CASES.length} labeled answers, ${nFalse} false claims) + LOOP GUARDS (${traces.length} synthetic 8-round traces)`,
        '| check        | precision | recall | false-claim pass rate |',
        '|--------------|-----------|--------|----------------------|',
        `| verifier ON  | ${precisionOn.toFixed(3)}     | ${recallOn.toFixed(3)}  | ${falseClaimRateOn.toFixed(3)}                |`,
        `| verifier OFF | 1.000     | ${recallOff.toFixed(3)}  | ${falseClaimRateOff.toFixed(3)}                |`,
        `| loop guards  | stall-trigger ${stallTriggerPct.toFixed(1)}% overall, looping ${loopingTrips}/${loopingTotal} tripped | wasted steps ${wastedOff} -> ${wastedOn} (saved ${wastedSaved}, ${wastedSavedPct.toFixed(1)}%) |`,
        `| (identical-stall cap MAX_IDENTICAL_ROUNDS=${MAX_IDENTICAL_ROUNDS}) |  |  |`,
        '',
        'VERIFIER MISSES:',
        ...(verifierMisses.length > 0 ? verifierMisses.map((m) => `  ${m}`) : ['  (none)']),
        'LOOP-GUARD MISSES:',
        ...(stallMisses.length > 0 ? stallMisses.map((m) => `  ${m}`) : ['  (none)']),
      ].join('\n'),
    );

    // acceptance: real functions, non-zero ON/OFF deltas, misses shown
    expect(on.p1).toBeGreaterThan(off.p1); // OFF recalls nothing -> P@1 0
    expect(on.r3).toBeGreaterThan(off.r3);
    expect(on.p1 - off.p1).toBeGreaterThan(0);
    expect(on.misses.length).toBeGreaterThan(0); // typo/distractor misses shown
    expect(recallOn).toBeGreaterThan(recallOff);
    expect(recallOn).toBeLessThan(1); // the 2 documented blind spots genuinely miss
    expect(verifierMisses.length).toBeGreaterThan(0);
    expect(falseClaimRateOn).toBeLessThan(falseClaimRateOff);
    expect(precisionOn).toBeGreaterThan(0.5);
    expect(loopingTrips).toBe(loopingTotal); // every looping trace trips
    expect(wastedSaved).toBeGreaterThan(0);
    expect(traces.filter((t) => t.kind === 'healthy' && guardTripRound(t) !== -1).length).toBe(0);
  });
});
