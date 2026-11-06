import { Socket } from 'node:net';
import type { ToolDefinition } from './index';

// `laya_decide` — ask the local laya server (same `:8000` as layarun.bat) a
// tiny decision question and get back one line. The big model calls this
// instead of burning a full round on yes/no/pick questions.
//
// Fallback contract (the whole point): laya is a speedup, never a
// dependency. Server off, slow, or erroring → return a plain
// "unavailable, decide yourself" line. Never throw, never block the loop:
// 2s cap per call, plus a 30s cached health knock so we don't even dial
// when we know it's down.
//
// Presets build the Jev-shaped questions internally, so the model never
// hand-writes question JSON — it sends {preset, state, options?} only.

export const LAYA_URL = 'http://127.0.0.1:8000';
const LAYA_TIMEOUT_MS = 2000;
const HEALTH_CACHE_MS = 30_000;

export type LayaPreset = 'intent' | 'safety' | 'relevant' | 'pick' | 'need-ground' | 'direct';

const INTENT_OPTIONS = ['chat', 'summarize', 'rewrite', 'click', 'type', 'open-app'] as const;
const DIRECT_OPTIONS = ['direct', 'agent', 'text-only'] as const;

function presetQuestions(preset: LayaPreset, options: string[]): Record<string, unknown> {
  switch (preset) {
    case 'intent':
      return {
        intent: {
          type: 'choice',
          instructions: 'What does the user want? Answer with the single best fit, including greetings and small talk.',
          criteria: {
            chat: 'just talking: greetings, thanks, bye, small talk, or any question answerable from knowledge',
            summarize: 'summarize, explain, describe, or tell the meaning of visible content',
            rewrite: 'rewrite, rephrase, paraphrase, fix, shorten, or improve the tone of visible text',
            click: 'click, press, or tap a button or element already on the screen',
            type: 'type, write, or dictate text into somewhere',
            'open-app': 'open, launch, start, or run an application or program by name',
          },
        },
      };
    case 'safety':
      return {
        sensitive: { type: 'noul', instructions: 'Is this about passwords, accounts, private messages, or something destructive?' },
      };
    case 'relevant':
      return {
        relevant: { type: 'noul', instructions: 'Is this question about what is currently on screen?' },
      };
    case 'need-ground':
      return {
        ground: { type: 'noul', instructions: 'To answer, must I locate a specific on-screen element first?' },
      };
    case 'direct':
      return {
        route: {
          type: 'choice',
          instructions: 'How should this be handled?',
          criteria: {
            direct: 'one direct tool call answers it (e.g. open an app)',
            agent: 'needs multi-step screen interaction',
            'text-only': 'answer from knowledge, no tools needed',
          },
        },
      };
    case 'pick': {
      const labels = options.slice(0, 20);
      const criteria: Record<string, string> = {};
      labels.forEach((label, i) => {
        criteria[`option_${i}`] = label;
      });
      return {
        pick: { type: 'choice', instructions: 'Which option fits best?', criteria },
      };
    }
  }
}

// Cheap door-knock: TCP connect only (no model load, milliseconds).
// Cached so rapid-fire tool calls don't re-knock every time.
let healthUntil = 0;
let healthOk = false;

export function layaHealthCached(): boolean {
  return Date.now() < healthUntil ? healthOk : false;
}

export function markLayaHealth(ok: boolean): void {
  healthOk = ok;
  healthUntil = Date.now() + HEALTH_CACHE_MS;
}

function knockLaya(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    const done = (ok: boolean): void => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try {
      sock.connect(port, host);
    } catch {
      done(false);
    }
  });
}

export async function isLayaUp(baseUrl: string = LAYA_URL): Promise<boolean> {
  if (Date.now() < healthUntil) return healthOk;
  try {
    const u = new URL(baseUrl);
    const ok = await knockLaya(u.hostname, Number(u.port) || 80, 500);
    markLayaHealth(ok);
    return ok;
  } catch {
    markLayaHealth(false);
    return false;
  }
}

interface LayaAnswer {
  text: string;
}

function renderVerdict(preset: LayaPreset, options: string[], answers: Record<string, unknown>): LayaAnswer {
  const pickLabel = (idx: number): string => options[idx] ?? `option_${idx}`;
  if (preset === 'intent') {
    const a = (answers.intent ?? {}) as { choice?: string; answer_confidence?: number };
    const choice = INTENT_OPTIONS.includes(a.choice as (typeof INTENT_OPTIONS)[number])
      ? (a.choice as string)
      : 'chat';
    return { text: `intent: ${choice} (${Math.round((a.answer_confidence ?? 0) * 100)}%)` };
  }
  if (preset === 'direct') {
    const a = (answers.route ?? {}) as { choice?: string; answer_confidence?: number };
    const choice = DIRECT_OPTIONS.includes(a.choice as (typeof DIRECT_OPTIONS)[number])
      ? (a.choice as string)
      : 'agent';
    return { text: `route: ${choice} (${Math.round((a.answer_confidence ?? 0) * 100)}%)` };
  }
  if (preset === 'pick') {
    const a = (answers.pick ?? {}) as { choice?: string; answer_confidence?: number };
    const m = /^option_(\d+)$/.exec(a.choice ?? '');
    const label = m ? pickLabel(Number(m[1])) : options[0] ?? 'none';
    return { text: `pick: ${label} (${Math.round((a.answer_confidence ?? 0) * 100)}%)` };
  }
  const key = preset === 'safety' ? 'sensitive' : preset === 'relevant' ? 'relevant' : 'ground';
  const a = (answers[key] ?? {}) as { noul?: number; answer_confidence?: number };
  const p = typeof a.noul === 'number' ? a.noul : 0.5;
  const yes = p >= 0.5;
  return { text: `${key}: ${yes ? 'yes' : 'no'} (${Math.round(p * 100)}%)` };
}

export async function askLaya(
  preset: LayaPreset,
  state: string,
  options: string[] = [],
  baseUrl: string = LAYA_URL,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (!(await isLayaUp(baseUrl))) {
    return 'laya unavailable (server off) — decide yourself.';
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LAYA_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state,
          questions: presetQuestions(preset, options),
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      markLayaHealth(false);
      return 'laya unavailable (server error) — decide yourself.';
    }
    const data = (await res.json()) as { answers?: Record<string, unknown> };
    if (!data.answers || typeof data.answers !== 'object') {
      return 'laya unavailable (bad reply) — decide yourself.';
    }
    return renderVerdict(preset, options, data.answers).text;
  } catch {
    markLayaHealth(false);
    return 'laya unavailable (too slow or down) — decide yourself.';
  }
}

const PRESETS = ['intent', 'safety', 'relevant', 'pick', 'need-ground', 'direct'] as const;

export const layaDecideTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'laya_decide',
      description:
        'Ask the instant local decider a tiny question (free, ~0.05s, on this PC). Use for yes/no/pick questions INSTEAD of reasoning it out: intent ("what does the user want?"), safety ("passwords/destructive?"), relevant ("about the current screen?"), need-ground ("must I locate an element first?"), direct ("one direct call, full agent loop, or text-only?"), pick ("which option from this list?"). If it replies "unavailable", decide yourself normally.',
      parameters: {
        type: 'object',
        properties: {
          preset: {
            type: 'string',
            enum: [...PRESETS],
            description: 'Which tiny question to ask.',
          },
          state: {
            type: 'string',
            description: 'The situation in plain words, e.g. the user prompt or what you see.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only for preset "pick": the option labels to choose between (max 20).',
          },
        },
        required: ['preset', 'state'],
      },
    },
  },
  uiLabel: (args) => {
    const p = String(args.preset ?? 'decide');
    return `Quick check: ${p.slice(0, 24)}`;
  },
  async execute(args) {
    const preset = String(args.preset ?? '');
    if (!(PRESETS as readonly string[]).includes(preset)) {
      return `Error: unknown preset "${preset}". Use one of: ${PRESETS.join(', ')}.`;
    }
    const state = String(args.state ?? '').trim();
    if (!state) return 'Error: laya_decide needs a "state" description.';
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === 'string').slice(0, 20)
      : [];
    if (preset === 'pick' && options.length === 0) {
      return 'Error: preset "pick" needs an "options" list.';
    }
    return askLaya(preset as LayaPreset, state, options);
  },
};
