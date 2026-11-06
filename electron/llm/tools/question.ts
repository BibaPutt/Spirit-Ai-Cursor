import type { ToolDefinition } from './index';

// `question` — schema-validated ask-the-user. The model often needs a
// decision only the human can make (which option, which file, proceed or
// not). Instead of asking in prose (easily ignored or malformed), it calls
// this tool: the JSON schema enforces well-formed questions, and the tool
// tells it to emit the [QUESTIONS] UI block verbatim. Read-only (text
// shaping only) → approval-free. Rejected/answered flow continues in the
// normal turn — the user's reply arrives as the next user message.

interface QuestionOption {
  label?: unknown;
  description?: unknown;
}

interface QuestionItem {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

function cleanOption(o: unknown): { label: string; description: string } | null {
  if (!o || typeof o !== 'object') return null;
  const label = String((o as QuestionOption).label ?? '').trim();
  if (!label) return null;
  const description = String((o as QuestionOption).description ?? '').trim();
  return { label: label.slice(0, 120), description: description.slice(0, 300) };
}

function cleanQuestion(q: unknown, index: number): { ok: true; json: string } | { ok: false; error: string } {
  if (!q || typeof q !== 'object') return { ok: false, error: `question ${index + 1} is not an object` };
  const item = q as QuestionItem;
  const question = String(item.question ?? '').trim();
  if (!question) return { ok: false, error: `question ${index + 1} needs a "question" text` };
  const header = String(item.header ?? '').trim() || `Question ${index + 1}`;
  const multiSelect = item.multiSelect === true;
  const options = Array.isArray(item.options) ? item.options.map(cleanOption).filter((o): o is NonNullable<typeof o> => o !== null) : [];
  if (options.length === 0) return { ok: false, error: `question ${index + 1} ("${question.slice(0, 60)}") needs at least one option with a label` };
  if (options.length > 6) return { ok: false, error: `question ${index + 1} has too many options (max 6)` };
  return {
    ok: true,
    json: JSON.stringify({ question, header, options, ...(multiSelect ? { multiSelect: true } : {}) }),
  };
}

export function buildQuestionsBlock(questions: unknown): { ok: true; block: string } | { ok: false; error: string } {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: 'provide a non-empty "questions" array' };
  }
  if (questions.length > 4) return { ok: false, error: 'at most 4 questions per call' };
  const cleaned: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const r = cleanQuestion(questions[i], i);
    if (!r.ok) return r;
    cleaned.push(r.json);
  }
  return {
    ok: true,
    block: `[QUESTIONS]\n${cleaned.join('\n')}\n[/QUESTIONS]`,
  };
}

export const questionTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'question',
      description:
        'Ask the USER a decision only they can make (which option, which file, proceed or not). Pass 1-4 questions with 1-6 labeled options each. After calling, emit the returned [QUESTIONS] block VERBATIM as your message text (nothing else) and stop — the user answers in the UI and their reply arrives next turn. Never ask in plain prose when this tool fits.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Questions for the user (1-4).',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The question text.' },
                header: { type: 'string', description: 'Short label shown above the options.' },
                multiSelect: { type: 'boolean', description: 'Allow picking more than one option.' },
                options: {
                  type: 'array',
                  description: 'Answer options (1-6).',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Option label (max 120 chars).' },
                      description: { type: 'string', description: 'What this option means (max 300 chars).' },
                    },
                    required: ['label'],
                  },
                },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  uiLabel: () => 'Asking a question',
  async execute(args) {
    const r = buildQuestionsBlock(args.questions);
    if (!r.ok) {
      return (
        `Error: invalid questions (${r.error}). Fix the shape and call again — ` +
        `each question needs "question" text and 1-6 options with "label".`
      );
    }
    return (
      `Emit the following block VERBATIM as your entire message text now (no other prose), then stop and wait for the user's reply:\n\n${r.block}`
    );
  },
};
