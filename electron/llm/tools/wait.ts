import type { ToolDefinition } from './index';

// `wait` lets the model plan multi-step task sequences that need real time
// between steps — e.g. launch an app, let it open, then type into it.
// It is intentionally NOT in APPROVAL_REQUIRED: pausing is harmless.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const waitTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'wait',
      description:
        'Pause between steps of a multi-step task. Use after launching an app or clicking so the UI has time to open before the next step. Example: wait(1000).',
      parameters: {
        type: 'object',
        properties: {
          ms: {
            type: 'integer',
            description: 'Milliseconds to wait, 100–5000.',
            minimum: 100,
            maximum: 5000,
          },
        },
        required: ['ms'],
      },
    },
  },
  uiLabel: (args) => `Waiting ${args.ms ?? 0} ms`,
  async execute(args) {
    const ms = Math.max(0, Math.min(5000, Number(args.ms) || 0));
    await sleep(ms);
    return `Waited ${ms} ms.`;
  },
};
