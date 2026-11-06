import type { ConversationTurn } from '../components/PromptInput';

// UI test seeds: fake past-conversation turns that exercise the transcript
// rail, folding, and snap scrolling with zero LLM calls. Local UI state
// only — never saved, never sent anywhere.

export type SeedTest = {
  id: string;
  label: string;
  hint: string;
  questions: string[];
};

export const SEED_TESTS: SeedTest[] = [
  {
    id: 'sample',
    label: 'Sample chat',
    hint: '5 mixed questions',
    questions: [
      'What is 2+2?',
      'Summarize this page in three bullets',
      'Write a haiku about rain',
      'Explain recursion like I am five',
      'List three keyboard shortcuts',
    ],
  },
  {
    id: 'long',
    label: 'Long answer',
    hint: 'headings, table, code',
    questions: ['Explain how the internet works'],
  },
  {
    id: 'many',
    label: 'Many turns',
    hint: '8 short questions for the rail',
    questions: [
      'What time is it?',
      'Capital of France?',
      'Best pizza topping?',
      'How tall is Everest?',
      'Who wrote Hamlet?',
      'Speed of light?',
      'Deepest ocean point?',
      'First man on the moon?',
    ],
  },
  {
    id: 'code',
    label: 'Code heavy',
    hint: 'snippets + table',
    questions: ['Show a quicksort in Python', 'Fix this null pointer: foo.bar() on line 42'],
  },
];

const RICH_BODY = `This is **seeded test data** — no model was called. It exercises the transcript rail, folding, and snap scrolling.

- First point with \`inline code\`
- Second point, a little longer so wrapping kicks in
- Third point

| Col A | Col B |
| --- | --- |
| one | two |
| three | four |

\`\`\`js
console.log("seed");
\`\`\`
`;

export function buildSeedTurns(test: SeedTest): ConversationTurn[] {
  const now = Date.now();
  return test.questions.map((q, i) => ({
    id: `seed-${now}-${i}`,
    prompt: q,
    wasWeb: false,
    response: RICH_BODY,
    uiSegments: [],
  }));
}
