import { describe, expect, it } from 'vitest';
import { runTaskTool } from '../electron/llm/tools/task';
import { buildQuestionsBlock, questionTool } from '../electron/llm/tools/question';
import type { ToolExecutionContext } from '../electron/llm/tools';

const ctx = {
  latestAssistantText: '',
  originalPrompt: 'x',
  abort: new AbortController().signal,
} as ToolExecutionContext;

describe('task tool', () => {
  it('requires a prompt', async () => {
    expect(await runTaskTool({}, ctx)).toMatch(/requires a "prompt"/);
  });

  it('reports cleanly when nested runs are unavailable', async () => {
    expect(await runTaskTool({ prompt: 'do it' }, ctx)).toMatch(/unavailable.*directly/);
  });

  it('returns the sub-agent answer trimmed and capped', async () => {
    const withSub: ToolExecutionContext = {
      ...ctx,
      runSubtask: async () => '  nested says hi  ',
    };
    expect(await runTaskTool({ prompt: 'do it' }, withSub)).toContain('nested says hi');
  });

  it('falls back when the sub-agent fails or is empty', async () => {
    const failing: ToolExecutionContext = {
      ...ctx,
      runSubtask: async () => {
        throw new Error('boom');
      },
    };
    expect(await runTaskTool({ prompt: 'do it' }, failing)).toMatch(/directly/);
    const empty: ToolExecutionContext = { ...ctx, runSubtask: async () => '   ' };
    expect(await runTaskTool({ prompt: 'do it' }, empty)).toMatch(/returned nothing/);
  });
});

describe('question tool', () => {
  it('emits a verbatim QUESTIONS block for valid input', async () => {
    const out = await questionTool.execute(
      {
        questions: [
          {
            question: 'Which file?',
            header: 'Pick',
            options: [
              { label: 'a.txt', description: 'first' },
              { label: 'b.txt' },
            ],
          },
        ],
      },
      ctx,
    );
    expect(out).toContain('[QUESTIONS]');
    expect(out).toContain('[/QUESTIONS]');
    expect(out).toContain('a.txt');
  });

  it('rejects bad shapes with fix guidance', () => {
    expect(buildQuestionsBlock([])).toMatchObject({ ok: false });
    expect(buildQuestionsBlock([{ question: 'x?' }])).toMatchObject({ ok: false });
    expect(
      buildQuestionsBlock(new Array(5).fill({ question: 'x?', options: [{ label: 'y' }] })),
    ).toMatchObject({ ok: false });
  });
});
