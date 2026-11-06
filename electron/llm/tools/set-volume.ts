import type { ToolDefinition } from './index';
import { setSystemVolume } from '../../system/audio';

// `set_volume` controls the OS output volume. Args are mutually-
// suggestive: callers should provide either an absolute `level`, a
// relative `delta`, or an `action` of 'mute' / 'unmute'.

export const setVolumeTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'set_volume',
      description:
        'Change the system volume. Use when the user says "louder", "quieter", "mute", "set volume to 30".',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'number', description: 'Absolute target 0-100.' },
          delta: { type: 'number', description: 'Relative change, e.g. +15 or -10.' },
          action: { type: 'string', enum: ['mute', 'unmute'], description: 'Mute or unmute output.' },
        },
      },
    },
  },
  uiLabel: (args) => {
    if (args.action === 'mute') return 'Muting audio';
    if (args.action === 'unmute') return 'Unmuting audio';
    if (typeof args.level === 'number') return `Setting volume to ${args.level}`;
    if (typeof args.delta === 'number') return args.delta >= 0 ? 'Turning up' : 'Turning down';
    return 'Adjusting volume';
  },
  async execute(args) {
    const level = typeof args.level === 'number' ? args.level : undefined;
    const delta = typeof args.delta === 'number' ? args.delta : undefined;
    const action = args.action === 'mute' || args.action === 'unmute'
      ? (args.action as 'mute' | 'unmute')
      : undefined;
    const result = await setSystemVolume({ level, delta, action });
    if (!result.ok) return `Error: ${result.error}`;
    if (typeof result.resultLevel === 'number') return `Volume set to ${result.resultLevel}.`;
    if (action) return action === 'mute' ? 'Audio muted.' : 'Audio unmuted.';
    return 'Volume adjusted.';
  },
};
