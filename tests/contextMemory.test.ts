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
  parseExtractionReply,
  hashText,
  scoreMemory,
  recallMemories,
  rememberTakeaways,
  splitRememberSection,
  stripMemoryBlock,
  withMemoryBlock,
  memoryContextBlock,
  memoryRememberInstruction,
  getBm25Params,
  normalizeBm25,
  getAllMemories,
  clearMemories,
  compressOldMemories,
  isWorthRemembering,
  deleteMemory,
  updateMemory,
  extractProfileUpdates,
  type ContextMemoryItem,
  type ExtractedMemory,
} from '../electron/memory/contextMemory';
import type { Message } from '../electron/llm/prompt';

function memory(text: string): ContextMemoryItem {
  const hash = hashText(text);
  return {
    id: hash.slice(0, 12),
    text,
    hash,
    attributedTo: 'user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    linkedMemoryIds: [],
    sources: [],
  };
}

function system(content: string): Message {
  return { role: 'system', content };
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.setEnabled(true);
  hoisted.setWorkspace(join(tmpdir(), 'spirit-context-memory-test'));
  await fs.mkdir(hoisted.getWorkspace(), { recursive: true });
  await clearMemories();
});

describe('parseExtractionReply', () => {
  it('parses a plain JSON object reply', () => {
    const out = parseExtractionReply(
      '{"memory":[{"text":"User prefers detailed answers","attributed_to":"user"}]}',
    );
    expect(out).toEqual([{ text: 'User prefers detailed answers', attributedTo: 'user' }]);
  });

  it('parses assistant-attributed entries', () => {
    const out = parseExtractionReply(
      '{"memory":[{"text":"Agent recommended X","attributed_to":"assistant"}]}',
    );
    expect(out).toEqual([{ text: 'Agent recommended X', attributedTo: 'assistant' }]);
  });

  it('parses linked_memory_ids', () => {
    const out = parseExtractionReply(
      '{"memory":[{"text":"User works on a budget app","linked_memory_ids":["abc123"]}]}',
    );
    expect(out).toEqual([
      { text: 'User works on a budget app', attributedTo: 'user', linkedMemoryIds: ['abc123'] },
    ]);
  });

  it('strips fenced code blocks', () => {
    const out = parseExtractionReply(
      '```json\n{"memory":[{"text":"User works on a budget app"}]}\n```',
    );
    expect(out).toEqual([{ text: 'User works on a budget app', attributedTo: 'user' }]);
  });

  it('returns [] for an empty result', () => {
    expect(parseExtractionReply('{"memory":[]}')).toEqual([]);
    expect(parseExtractionReply('not json at all')).toEqual([]);
    expect(parseExtractionReply('')).toEqual([]);
  });

  it('drops entries with too-short text', () => {
    expect(parseExtractionReply('{"memory":[{"text":"ok"}]}')).toEqual([]);
  });
});

describe('hashText', () => {
  it('is case/whitespace-insensitive', () => {
    expect(hashText('  Likes coffee ')).toBe(hashText('likes coffee'));
  });
  it('differs for different content', () => {
    expect(hashText('likes coffee')).not.toBe(hashText('likes tea'));
  });
});

describe('BM25 params + normalization (ported from mem0)', () => {
  it('getBm25Params scales with query length', () => {
    expect(getBm25Params('short query')).toEqual([5.0, 0.7]);
    expect(getBm25Params('a somewhat longer query here please')).toEqual([7.0, 0.6]);
    expect(getBm25Params('a b c d e f g h i j k l m n o')).toEqual([10.0, 0.5]);
    expect(getBm25Params('a b c d e f g h i j k l m n o p q r s t')).toEqual([12.0, 0.5]);
  });

  it('normalizeBm25 is a monotonic sigmoid in [0,1]', () => {
    expect(normalizeBm25(100, 5, 7)).toBeGreaterThan(normalizeBm25(0, 5, 7));
    expect(normalizeBm25(100, 5, 7)).toBeLessThanOrEqual(1);
    expect(normalizeBm25(-100, 5, 7)).toBeGreaterThanOrEqual(0);
  });
});

describe('scoreMemory', () => {
  it('scores keyword overlap', () => {
    const m = memory('User is building a budget tracker app');
    expect(scoreMemory('budget tracker app', m)).toBeGreaterThan(0);
    expect(scoreMemory('the weather today in paris', m)).toBe(0);
  });
});

describe('memoryContextBlock', () => {
  it('renders recalled memories with ids', () => {
    const block = memoryContextBlock([memory('User wants detailed answers')]);
    expect(block).toContain('# Context memory');
    expect(block).toContain('User wants detailed answers');
    expect(block).toMatch(/\[[a-z0-9]+\]/);
  });
  it('returns empty string for no memories', () => {
    expect(memoryContextBlock([])).toBe('');
  });
});

describe('memoryRememberInstruction', () => {
  it('is a condensed additive extraction prompt', () => {
    const inst = memoryRememberInstruction();
    expect(inst).toContain('Key takeaways:');
    expect(inst).toContain('[update <id>]');
    expect(inst).toContain('[delete <id>]');
    expect(inst).toContain('Attribute correctly');
  });
});

describe('splitRememberSection', () => {
  it('strips the trailing section and returns takeaways', () => {
    const reply = [
      'Here is the breakdown.',
      '',
      'Key takeaways:',
      '- User prefers step-by-step answers',
      '- User is learning Spanish',
    ].join('\n');
    const { cleaned, takeaways } = splitRememberSection(reply);
    expect(cleaned).toBe('Here is the breakdown.');
    expect(takeaways.map((t) => t.text)).toEqual([
      'User prefers step-by-step answers',
      'User is learning Spanish',
    ]);
  });

  it('parses [update <id>] and [delete <id>] markers', () => {
    const reply = [
      'Ok.',
      '',
      'Key takeaways:',
      '- [update abcd1234] User now prefers brief answers',
      '- [delete efgh5678] User is no longer learning Spanish',
      '- User got a new job',
    ].join('\n');
    const { takeaways } = splitRememberSection(reply);
    expect(takeaways[0]).toMatchObject({ updateId: 'abcd1234' });
    expect(takeaways[1]).toMatchObject({ deleteId: 'efgh5678' });
    expect(takeaways[2]).toMatchObject({ text: 'User got a new job' });
  });

  it('parses [personal] alone and combined with [update]', () => {
    const reply = [
      'Ok.',
      '',
      'Key takeaways:',
      "- [personal] User's name is Ana",
      '- [update abcd1234] [personal] User now works as a designer',
      '- [personal] [update efgh5678] User moved to Berlin',
      '- User likes dark mode',
    ].join('\n');
    const { takeaways } = splitRememberSection(reply);
    expect(takeaways[0]).toMatchObject({ text: "User's name is Ana", personal: true });
    expect(takeaways[1]).toMatchObject({
      updateId: 'abcd1234',
      personal: true,
      text: 'User now works as a designer',
    });
    expect(takeaways[2]).toMatchObject({ updateId: 'efgh5678', personal: true });
    expect(takeaways[3]).toMatchObject({ text: 'User likes dark mode', personal: false });
  });

  it('handles markdown-style headers and bold', () => {
    const { cleaned, takeaways } = splitRememberSection(
      'Sure.\n\n## **Key Takeaways**\n- User likes dark mode',
    );
    expect(cleaned).toBe('Sure.');
    expect(takeaways).toHaveLength(1);
  });

  it('returns the reply untouched when there is no section', () => {
    const reply = 'Just a normal answer with no memory section.';
    expect(splitRememberSection(reply)).toEqual({ cleaned: reply, takeaways: [] });
  });

  it('drops fluff bullets (too-short text)', () => {
    const { takeaways } = splitRememberSection(
      'Ok.\n\nKey takeaways:\n- hi\n- User is tall',
    );
    expect(takeaways).toHaveLength(1);
  });
});

describe('stripMemoryBlock + withMemoryBlock', () => {
  it('injects the remember instruction and recalled block into the system message', async () => {
    await rememberTakeaways([{ text: 'User prefers step-by-step answers' }], ['ocr']);
    const messages = [system('You are Spirit.'), { role: 'user', content: 'explain' }];
    const out = await withMemoryBlock(messages, 'step by step answers');
    expect(out[0].content).toContain('<!--SPIRIT-MEMORY-->');
    expect(out[0].content).toContain('Long-term memory capture');
    expect(out[0].content).toContain('User prefers step-by-step answers');
    expect(out[0].content).toContain('<!--/SPIRIT-MEMORY-->');
    // Original messages untouched.
    expect(messages[0].content).not.toContain('<!--SPIRIT-MEMORY-->');
  });

  it('stripMemoryBlock removes an injected block exactly', () => {
    const content = 'You are Spirit.\n\n<!--SPIRIT-MEMORY-->\n# Context memory\n- [abc] x\n<!--/SPIRIT-MEMORY-->';
    expect(stripMemoryBlock(content)).toBe('You are Spirit.');
  });

  it('stripMemoryBlock is idempotent', () => {
    const content = 'plain';
    expect(stripMemoryBlock(content)).toBe('plain');
  });

  it('withMemoryBlock re-injects fresh after stripping a stale block', async () => {
    const messages = [
      system(
        'You are Spirit.\n\n<!--SPIRIT-MEMORY-->\n# Context memory\n- [old] stale\n<!--/SPIRIT-MEMORY-->',
      ),
      { role: 'user', content: 'hello' },
    ];
    const out = await withMemoryBlock(messages, 'nothing relevant');
    expect(out[0].content).not.toContain('[old] stale');
    expect(out[0].content).toContain('<!--SPIRIT-MEMORY-->');
  });

  it('returns messages unchanged when memory is disabled', async () => {
    hoisted.setEnabled(false);
    const messages = [system('You are Spirit.'), { role: 'user', content: 'hi' }];
    const out = await withMemoryBlock(messages, 'hi');
    expect(out[0].content).toBe('You are Spirit.');
  });
});

describe('rememberTakeaways + recallMemories', () => {
  it('stores durable facts with sources', async () => {
    const result = await rememberTakeaways(
      [{ text: 'User prefers step-by-step answers' }],
      ['ocr', 'clipboard'],
    );
    expect(result).toEqual({ added: 1, updated: 0, deleted: 0, total: 1, addedTexts: ['User prefers step-by-step answers'] });
    const stored = await getAllMemories();
    expect(stored[0].text).toBe('User prefers step-by-step answers');
    expect(stored[0].sources).toEqual(['ocr', 'clipboard']);
    expect(stored[0].attributedTo).toBe('user');
  });

  it('recalls the most relevant fact by BM25', async () => {
    await rememberTakeaways([
      { text: 'User prefers step-by-step answers' },
      { text: 'User is planning a trip to Tokyo' },
    ]);
    const recalled = await recallMemories('explain step by step please');
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0].text).toBe('User prefers step-by-step answers');
  });

  it('dedupes by content hash', async () => {
    await rememberTakeaways([{ text: 'User prefers detailed answers' }]);
    const result = await rememberTakeaways([{ text: 'User prefers detailed answers' }]);
    expect(result.added).toBe(0);
    expect(result.total).toBe(1);
  });

  it('updates a fact via [update <id>] marker', async () => {
    const first = await rememberTakeaways([{ text: 'User prefers brief answers' }]);
    const id = (await getAllMemories())[0].id;
    const result = await rememberTakeaways([
      { text: 'User now prefers detailed answers', updateId: id },
    ]);
    expect(result).toEqual({ added: 0, updated: 1, deleted: 0, total: 1, addedTexts: [] });
    const stored = await getAllMemories();
    expect(stored).toHaveLength(first.total);
    expect(stored[0].text).toBe('User now prefers detailed answers');
  });

  it('deletes a fact via [delete <id>] marker and cleans links', async () => {
    await rememberTakeaways([
      { text: 'User is learning Spanish' },
      { text: 'User studies every evening' },
    ]);
    const [spanish, evening] = await getAllMemories();
    // Link the two so the deletion must also purge the reference.
    await fs.writeFile(
      join(hoisted.getWorkspace(), 'context-memory.json'),
      JSON.stringify([
        { ...spanish, linkedMemoryIds: [evening.id] },
        { ...evening, linkedMemoryIds: [spanish.id] },
      ]),
      'utf-8',
    );
    const result = await rememberTakeaways([{ text: 'no longer relevant', deleteId: spanish.id }]);
    expect(result.deleted).toBe(1);
    const stored = await getAllMemories();
    expect(stored).toHaveLength(1);
    expect(stored[0].linkedMemoryIds).toEqual([]);
  });

  it('updates an existing fact in place when a later one augments it (mem0 UPDATE)', async () => {
    await rememberTakeaways([{ text: 'User is building a budget tracker app' }]);
    const result = await rememberTakeaways([{ text: 'User is building the budget tracker in React' }]);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    const stored = await getAllMemories();
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toContain('React');
  });

  it('links genuinely distinct facts that share the subject without merging them', async () => {
    await rememberTakeaways([{ text: 'User is building a budget tracker app' }]);
    const result = await rememberTakeaways([{ text: 'User tracks a separate budget for groceries' }]);
    expect(result.added).toBe(1);
    const stored = await getAllMemories();
    expect(stored).toHaveLength(2);
    expect(stored[1].linkedMemoryIds.length).toBeGreaterThan(0);
  });

  it('does nothing when disabled', async () => {
    hoisted.setEnabled(false);
    const result = await rememberTakeaways([{ text: 'User prefers detailed answers' }]);
    expect(result.added).toBe(0);
    expect(await recallMemories('detailed answers')).toEqual([]);
  });

  it('recallMemories is disabled-aware', async () => {
    await rememberTakeaways([{ text: 'User works on a game project' }]);
    expect((await getAllMemories()).length).toBe(1);
    hoisted.setEnabled(false);
    expect(await recallMemories('game project')).toEqual([]);
  });

  it('persists to the workspace file', async () => {
    await rememberTakeaways([{ text: 'User is learning Spanish' }]);
    const raw = await fs.readFile(join(hoisted.getWorkspace(), 'context-memory.json'), 'utf-8');
    const parsed = JSON.parse(raw) as ContextMemoryItem[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('User is learning Spanish');
  });
});

describe('compressOldMemories', () => {
  it('merges a batch into fewer summaries', async () => {
    const old = [
      memory('User prefers dark mode'),
      memory('User prefers dark mode for all apps'),
      memory('User is learning Spanish'),
    ];
    mockRunPlainCompletion.mockResolvedValueOnce(
      '{"memory":[{"text":"User prefers dark mode in every app; is learning Spanish"}]}',
    );
    const out = await compressOldMemories(old);
    expect(out.length).toBeLessThan(old.length);
    expect(out[0].text).toContain('dark mode');
  });

  it('keeps the original batch when the model returns junk or nothing', async () => {
    const old = [memory('User prefers dark mode'), memory('User is learning Spanish')];
    mockRunPlainCompletion.mockResolvedValueOnce('not json');
    const out = await compressOldMemories(old);
    expect(out).toHaveLength(2);
  });

  it('returns empty for an empty batch', async () => {
    expect(await compressOldMemories([])).toEqual([]);
  });
});

describe('types sanity', () => {
  it('ExtractedMemory accepts optional update/delete/linked ids', () => {
    const m: ExtractedMemory = {
      text: 'x fact',
      attributedTo: 'user',
      updateId: 'a1',
      linkedMemoryIds: ['b2'],
    };
    expect(m.updateId).toBe('a1');
    expect(m.linkedMemoryIds).toEqual(['b2']);
  });
});

describe('hybrid recall, quality gate, dedupe, and /memory manager ops', () => {
  it('recalls a fact via synonym expansion (precipitation ~ rain)', async () => {
    await rememberTakeaways([
      { text: 'User tracks the rain cycle every week' },
      { text: 'User is planning a trip to Tokyo' },
    ]);
    const recalled = await recallMemories('explain the precipitation patterns please');
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0].text).toContain('rain cycle');
  });

  it('recalls via a shared synonym family (car ~ vehicle)', async () => {
    await rememberTakeaways([{ text: 'User is restoring a 1967 car' }]);
    const recalled = await recallMemories('tell me about the old vehicle restoration');
    expect(recalled[0].text).toContain('car');
  });

  it('keeps user-anchored facts but drops generic definitional ones', async () => {
    const result = await rememberTakeaways([
      { text: 'Cows are domesticated ruminants used worldwide for milk production' },
      { text: 'User prefers detailed answers' },
    ]);
    expect(result.added).toBe(1);
    const stored = await getAllMemories();
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toContain('prefers');
  });

  it('isWorthRemembering classifies facts directly', () => {
    expect(isWorthRemembering('Cows are domesticated ruminants used worldwide for milk', 'user')).toBe(false);
    expect(isWorthRemembering('User keeps 14 cows at her farm', 'user')).toBe(true);
    expect(isWorthRemembering('User was recommended the Osteria Francescana', 'assistant')).toBe(true);
    expect(isWorthRemembering('User got a new job', 'user')).toBe(true);
  });

  it('merges a near-duplicate into the existing memory instead of stacking', async () => {
    await rememberTakeaways([{ text: 'User prefers detailed answers' }], ['ocr']);
    const second = await rememberTakeaways(
      [{ text: 'User prefers very detailed answers' }],
      ['clipboard'],
    );
    expect(second.added).toBe(0);
    const stored = await getAllMemories();
    expect(stored).toHaveLength(1);
    expect(stored[0].sources).toEqual(['ocr', 'clipboard']);
  });

  it('deleteMemory removes one entry and purges its links', async () => {
    await rememberTakeaways([
      { text: 'User is learning Spanish' },
      { text: 'User studies every evening' },
    ]);
    const [spanish] = await getAllMemories();
    expect(await deleteMemory(spanish.id)).toBe(true);
    const stored = await getAllMemories();
    expect(stored).toHaveLength(1);
    expect(await deleteMemory('does-not-exist')).toBe(false);
  });

  it('updateMemory replaces text by id', async () => {
    await rememberTakeaways([{ text: 'User prefers brief answers' }]);
    const id = (await getAllMemories())[0].id;
    expect(await updateMemory(id, 'User prefers detailed answers now')).toBe(true);
    const stored = await getAllMemories();
    expect(stored[0].text).toBe('User prefers detailed answers now');
  });

  it('updateMemory rejects unknown ids and too-short text', async () => {
    expect(await updateMemory('nope', 'A valid enough sentence')).toBe(false);
    await rememberTakeaways([{ text: 'User prefers brief answers' }]);
    const id = (await getAllMemories())[0].id;
    expect(await updateMemory(id, 'ok')).toBe(false);
  });
});

describe('extractProfileUpdates', () => {
  it('learns name, role and language from takeaways', () => {
    expect(
      extractProfileUpdates([
        { text: "User's name is Ana" },
        { text: 'User works as a product designer.' },
        { text: 'User prefers German replies.' },
      ]),
    ).toEqual({ name: 'Ana', role: 'product designer', preferredLanguage: 'German' });
  });

  it('ignores non-personal facts', () => {
    expect(
      extractProfileUpdates([
        { text: 'User prefers brief answers' },
        { text: 'Germany exported 92bn in machinery' },
      ]),
    ).toEqual({});
  });

  it('first value wins, rejects placeholders', () => {
    expect(
      extractProfileUpdates([
        { text: "User's name is Ana" },
        { text: "User's name is Bob" },
        { text: "User's name is unknown" },
      ]),
    ).toEqual({ name: 'Ana' });
  });

  it('prefers model-tagged [personal] bullets over untagged matches', () => {
    expect(
      extractProfileUpdates([
        { text: 'User met Ana yesterday' },
        { text: "User's name is Zoe", personal: true },
      ]),
    ).toEqual({ name: 'Zoe' });
  });

  it('[personal] bullets bypass the worth gate but still dedupe', async () => {
    // "Ana's timezone is CET" is not user-anchored and has no preference
    // verb — untagged the gate would drop it.
    const tagged = await rememberTakeaways([{ text: "Ana's timezone is CET", personal: true }]);
    expect(tagged.added).toBe(1);
    const dup = await rememberTakeaways([{ text: "Ana's timezone is CET", personal: true }]);
    expect(dup.added).toBe(0);
    const untagged = await rememberTakeaways([{ text: "Bob's timezone is PST" }]);
    expect(untagged.added).toBe(0);
  });
});
