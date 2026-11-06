import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'spirit-test'),
    getName: () => 'Spirit',
    getVersion: () => 'test',
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
  },
}));
import { PROVIDER_ORDER } from '../electron/llm/providers/registry';
import { classifyError, codeForStatus } from '../electron/llm/providers/error-classify';
import { ProviderHttpError, shouldRetryStatus } from '../electron/llm/providers/types';
import { estimateTokens } from '../electron/memory/sessions';
import { MAX_TOKENS, ROUND_TIMEOUT_MS } from '../electron/llm/models';

// EXP-7full + EXP-10 GENUINE: provider fallback-chain planning + cost reference.
// Rules: real classifyError / estimateTokens / PROVIDER_ORDER / timeouts only.
// No paid API calls anywhere. Cloud prices are FORMULA-ONLY snapshots.

// Real source extraction: MAX_ROUNDS lives inside runAgenticLoopWithProvider
// (not exported), so read the real router source instead of hardcoding blindly.
function readMaxRoundsFromRouterSource(): number {
  const p = path.join(__dirname, '..', 'electron', 'llm', 'providers', 'router.ts');
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(/const MAX_ROUNDS\s*=\s*(\d+)/);
  if (!m) throw new Error('MAX_ROUNDS not found in router.ts source');
  return Number(m[1]);
}

// Mirrors runPlainCompletion's chain-walk decision logic (router.ts ~L858-895)
// EXACTLY: aborted-signal -> continue; 401/403 -> STOP (throw); ProviderHttpError
// with shouldRetryStatus(408/425/429/5xx) -> continue; ANYTHING else (plain
// network Errors, bare timeout strings without an abort) -> throw (stop).
// Uses REAL classifyError + shouldRetryStatus for the code labels.
function planFallback(
  order: string[],
  failures: Map<string, { err: unknown; aborted: boolean }>,
): { tried: string[]; outcome: 'would-continue' | 'stop-auth' | 'stop-throw'; stopAt?: string; codes: string[] } {
  const tried: string[] = [];
  const codes: string[] = [];
  for (const id of order) {
    tried.push(id);
    const slot = failures.get(id);
    if (slot === undefined) return { tried, outcome: 'would-continue', codes }; // success ends chain
    const { err, aborted } = slot;
    const code = classifyError(err, id).code;
    codes.push(`${id}:${code}`);
    if (aborted) continue; // router: controller.signal.aborted -> continue
    if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
      return { tried, outcome: 'stop-auth', stopAt: id, codes };
    }
    if (err instanceof ProviderHttpError && shouldRetryStatus(err.status)) continue;
    return { tried, outcome: 'stop-throw', stopAt: id, codes };
  }
  return { tried, outcome: 'would-continue', codes };
}

describe('EXP-7full+EXP-10 genuine: fallback chain + cost reference (no cloud spend)', () => {
  it('uses the REAL provider order (openrouter first, local last-ish)', () => {
    expect(PROVIDER_ORDER).toEqual([
      'openrouter',
      'anthropic',
      'openai',
      'gemini',
      'localai',
      'opencode',
    ]);
    // eslint-disable-next-line no-console
    console.log('\nFALLBACK TABLE (real PROVIDER_ORDER + real classifyError/shouldRetryStatus)');
    console.log('rank | provider   | failure simulated            | real code      | chain action');
    console.log('-----|------------|--------------------------------|----------------|-------------');
    const scenarios: Array<[string, unknown, boolean]> = [
      ['openrouter', new ProviderHttpError('rate limited', 429, 'openrouter'), false],
      ['anthropic', new ProviderHttpError('overloaded', 503, 'anthropic'), false],
      ['openai', new Error('fetch failed'), false],
      ['gemini', new Error('Request timed out after 150000ms'), true],
      ['localai', new ProviderHttpError('quota exceeded', 402, 'localai' as never), false],
    ];
    scenarios.forEach(([id, err, aborted], i) => {
      const code = classifyError(err, id).code;
      // Same rule as planFallback / router runPlainCompletion: aborted ->
      // continue; 401/403 -> STOP; shouldRetryStatus -> CONTINUE; else STOP.
      let action: string;
      if (aborted) action = 'CONTINUE (abort)';
      else if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) action = 'STOP (auth)';
      else if (err instanceof ProviderHttpError && shouldRetryStatus(err.status)) action = 'CONTINUE';
      else action = 'STOP (throw)';
      // eslint-disable-next-line no-console
      console.log(
        `${String(i + 1).padEnd(4)} | ${id.padEnd(10)} | ${(err as Error).message.slice(0, 30).padEnd(30)} | ${code.padEnd(14)} | ${action}`,
      );
    });
  });

  it('plans chain walks with REAL classification (retry continues, auth stops)', () => {
    // 429/502 continue (shouldRetryStatus); aborted-timeout continues;
    // a plain network Error WITHOUT abort STOPS the chain (router rethrows).
    const cont = planFallback(
      [...PROVIDER_ORDER],
      new Map([
        ['openrouter', { err: new ProviderHttpError('rate limited', 429, 'openrouter'), aborted: false }],
        ['anthropic', { err: new ProviderHttpError('bad gateway', 502, 'anthropic'), aborted: false }],
        ['openai', { err: new Error('Request timed out'), aborted: true }],
      ]),
    );
    expect(cont.codes).toEqual([
      'openrouter:overloaded',
      'anthropic:overloaded',
      'openai:timeout',
    ]);
    expect(cont.tried).toContain('gemini'); // chain continued past all three
    expect(codeForStatus(429)).toBe('overloaded');
    // Plain network error without abort stops the chain (documents router behavior).
    expect(classifyError(new Error('fetch failed'), 'openai').code).toBe('network');
    const netStop = planFallback(
      [...PROVIDER_ORDER],
      new Map([
        ['openrouter', { err: new ProviderHttpError('rate limited', 429, 'openrouter'), aborted: false }],
        ['anthropic', { err: new Error('fetch failed'), aborted: false }],
      ]),
    );
    expect(netStop.outcome).toBe('stop-throw');
    expect(netStop.stopAt).toBe('anthropic');

    // Auth stops the chain immediately (router rethrows, no quota burn).
    const auth = planFallback(
      [...PROVIDER_ORDER],
      new Map([
        ['openrouter', { err: new ProviderHttpError('invalid api key', 401, 'openrouter'), aborted: false }],
      ]),
    );
    expect(auth.outcome).toBe('stop-auth');
    expect(auth.stopAt).toBe('openrouter');
    expect(auth.tried).toEqual(['openrouter']);

    // Credits (402) is NOT in shouldRetryStatus -> router rethrows (stop-throw).
    const credits = planFallback(
      [...PROVIDER_ORDER],
      new Map([
        ['openrouter', { err: new ProviderHttpError('quota exceeded', 402, 'openrouter'), aborted: false }],
      ]),
    );
    expect(classifyError(new ProviderHttpError('quota exceeded', 402, 'openrouter')).code).toBe('credits');
    expect(shouldRetryStatus(402)).toBe(false);
    expect(credits.outcome).toBe('stop-throw');
  });

  it('timeout abort uses a REAL AbortController + timer (no network)', async () => {
    // Real abort mechanics, miniature timeout so the test stays fast.
    // Production value asserted separately below (ROUND_TIMEOUT_MS).
    expect(ROUND_TIMEOUT_MS).toBe(240_000);
    const controller = new AbortController();
    let settled: string | null = null;
    const pending = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => controller.abort(new Error('timeout')), 20);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(controller.signal.reason ?? new Error('timeout'));
      });
      void t;
    });
    try {
      await pending;
      settled = 'resolved-unexpectedly';
    } catch (err) {
      settled = controller.signal.aborted ? 'aborted' : 'rejected-open';
      // Router path: aborted -> continue chain; classification is real.
      expect(controller.signal.aborted).toBe(true);
      expect(classifyError(err, 'openrouter').code).toBe('timeout');
    }
    expect(settled).toBe('aborted');
  });

  it('estimates tokens with REAL estimateTokens on ~4k-token prompts + budget math', () => {
    const MAX_ROUNDS = readMaxRoundsFromRouterSource();
    expect(MAX_ROUNDS).toBe(8);
    expect(MAX_TOKENS).toBe(32768);

    // ~4k tokens ~= 16k chars at 4 chars/token (sessions.ts CHARS_PER_TOKEN).
    const prompt4k = 'x'.repeat(16_000);
    const est = estimateTokens({ role: 'user', content: prompt4k } as never);
    expect(est).toBe(4000);
    // Image block costs a real fixed 1500 tokens.
    const withImage = estimateTokens({
      role: 'user',
      content: [
        { type: 'text', text: 'see screen' },
        { type: 'image_url', image_url: { url: 'data:...' } },
      ],
    } as never);
    expect(withImage).toBe(Math.ceil('see screen'.length / 4) + 1500);

    const maxOutputPerTask = MAX_ROUNDS * MAX_TOKENS; // 8 x 32768
    expect(maxOutputPerTask).toBe(262_144);
    const promptTokensPerRound = est + 1500; // prompt + screenshot
    const worstCasePerTask = MAX_ROUNDS * (promptTokensPerRound + MAX_TOKENS);

    // eslint-disable-next-line no-console
    console.log('\nCOST MODEL TABLE (FORMULA-ONLY snapshot — NO paid API calls made)');
    console.log('model              | tokens/task (worst) | price formula (per 1M tok)                 | est. cost/task');
    console.log('-------------------|---------------------|--------------------------------------------|----------------');
    const rows: Array<[string, string]> = [
      ['local (ollama)   ', '$0.00 (free, electricity only)'],
      ['openrouter free  ', '$0.00 (free-tier, rate-limited)'],
      ['cloud ref A      ', `(${(worstCasePerTask / 1e6).toFixed(4)}M in × $P_in) + (${(maxOutputPerTask / 1e6).toFixed(4)}M out × $P_out)`],
      ['cloud ref B      ', `same formula, vendor B rates; snapshot only`],
    ];
    for (const [model, cost] of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `${model} | ${String(worstCasePerTask).padEnd(19)} | ${'in+out per-1M formula'.padEnd(42)} | ${cost}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `budget: MAX_ROUNDS=${MAX_ROUNDS} × MAX_TOKENS=${MAX_TOKENS} = ${maxOutputPerTask} output tok/task max; ` +
        `round timeout=${ROUND_TIMEOUT_MS}ms; 4k-prompt est=${est} tok (+1500 screenshot).`,
    );
    // eslint-disable-next-line no-console
    console.log('NOTE: cloud rows are FORMULA-ONLY placeholders (P_in/P_out = vendor list price); no cloud API was called.');
  });
});
