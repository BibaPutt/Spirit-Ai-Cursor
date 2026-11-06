import type { ToolDefinition, ToolExecutionContext } from './index';

// `task` — fenced sub-agent loop for one goal. The model delegates a
// self-contained piece ("summarize these three files", "find the login
// button's element id") and gets back a final answer string, which it must
// verify before using. Depth-capped at 1 by the router (no nesting):
// inside a subtask the tool is hidden. Approval-gated like other acting
// tools; every nested tool call still goes through its own approval.

export async function runTaskTool(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  const description = String(args.description ?? '').trim();
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) return 'Error: task requires a "prompt" (the goal for the sub-agent).';
  if (!ctx.runSubtask) {
    return 'Error: nested runs are unavailable in this context — do the work directly with your own tools.';
  }
  const goal = description ? `${description}\n\n${prompt}` : prompt;
  try {
    const answer = await ctx.runSubtask(goal);
    const trimmed = answer.trim();
    if (!trimmed) return 'Error: the sub-agent returned nothing — do the work directly with your own tools.';
    return `Sub-agent result:\n${trimmed.slice(0, 6000)}`;
  } catch (err) {
    return `Error: sub-agent failed (${err instanceof Error ? err.message : String(err)}) — do the work directly with your own tools.`;
  }
}

export const taskTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'task',
      description:
        'Delegate a self-contained sub-task to a fenced sub-agent (own context, same tools except further nesting) and get back its final answer. Use for parallelizable or distracting pieces: summarizing files, scouting UI, drafting. Keep the prompt self-contained — the sub-agent sees ONLY what you put in description+prompt. Verify its answer before using it. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Short label (3-5 words) for the activity row.',
          },
          prompt: {
            type: 'string',
            description: 'Complete goal for the sub-agent, with all context it needs.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  uiLabel: (args) => {
    const d = String(args.description ?? '').trim();
    return d ? `Subtask: ${d.slice(0, 40)}` : 'Running subtask';
  },
  execute: runTaskTool,
};
