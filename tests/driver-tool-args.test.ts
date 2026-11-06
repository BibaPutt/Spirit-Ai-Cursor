import { describe, expect, it } from 'vitest';
import {
  areAllTools,
  buildDriverCall,
  splitCombo,
} from '../electron/input/driver-tool-args';

const full = areAllTools(['click', 'type_text', 'scroll', 'press_key', 'hotkey', 'drag', 'get_cursor_position']);
const clicksOnly = areAllTools(['click', 'get_cursor_position']);
const noDrag = areAllTools(['click', 'type_text', 'scroll', 'press_key', 'hotkey', 'get_cursor_position']);
const noHotkey = areAllTools(['click', 'type_text', 'scroll', 'press_key', 'drag', 'get_cursor_position']);
const empty = areAllTools([]);

describe('splitCombo', () => {
  it('maps modifier spellings to driver names', () => {
    expect(splitCombo('ctrl+n')).toEqual({ modifiers: ['ctrl'], key: 'n' });
    expect(splitCombo('control+shift+s')).toEqual({ modifiers: ['ctrl', 'shift'], key: 's' });
    expect(splitCombo('cmd+alt+e')).toEqual({ modifiers: ['win', 'alt'], key: 'e' });
    expect(splitCombo('super+shift+t')).toEqual({ modifiers: ['win', 'shift'], key: 't' });
  });

  it('maps key aliases to driver names and forwards bare keys', () => {
    expect(splitCombo('enter')).toEqual({ modifiers: [], key: 'return' });
    expect(splitCombo('escape')).toEqual({ modifiers: [], key: 'escape' });
    expect(splitCombo('arrowup')).toEqual({ modifiers: [], key: 'up' });
    expect(splitCombo('f5')).toEqual({ modifiers: [], key: 'f5' });
    expect(splitCombo('space')).toEqual({ modifiers: [], key: 'space' });
  });

  it('rejects bare modifiers and unknown keys', () => {
    expect(splitCombo('ctrl')).toMatchObject({ error: expect.stringContaining('bare modifier') });
    expect(splitCombo('ctrl+alt+shift')).toMatchObject({
      error: expect.stringContaining('bare modifier'),
    });
    expect(splitCombo('capslock')).toMatchObject({ error: 'unknown key "capslock"' });
    expect(splitCombo('ctrl+a+b')).toMatchObject({
      error: expect.stringContaining('too many keys'),
    });
    expect(splitCombo('')).toMatchObject({ error: 'empty key combo' });
  });
});

describe('buildDriverCall', () => {
  it('builds a desktop-scope click with count 1 by default', () => {
    const call = buildDriverCall({ kind: 'click', x: 12.4, y: 345.9, count: 1 }, full)!;
    expect(call).not.toBeNull();
    expect(call.tool).toBe('click');
    expect(call.args).toMatchObject({
      session: 'spirit',
      scope: 'desktop',
      delivery_mode: 'background',
      button: 'left',
      count: 1,
      x: 12,
      y: 346,
    });
  });

  it('builds right + double clicks and clamps count to 1–3', () => {
    const right = buildDriverCall({ kind: 'click', x: 0, y: 0, button: 'right', count: 1 }, full)!;
    expect(right.args.button).toBe('right');
    const dbl = buildDriverCall({ kind: 'click', x: 0, y: 0, count: 2 }, full)!;
    expect(dbl.args.count).toBe(2);
    const clamped = buildDriverCall({ kind: 'click', x: 0, y: 0, count: 7 }, full)!;
    expect(clamped.args.count).toBe(3);
  });

  it('type_text sets a sane delay, never negative or insane', () => {
    const call = buildDriverCall({ kind: 'type_text', text: 'hi' }, full)!;
    expect(call.args.delay_ms).toBe(20);
    const tiny = buildDriverCall({ kind: 'type_text', text: 'x', delayMs: -400 }, full)!;
    expect(tiny.args.delay_ms).toBe(0);
    const huge = buildDriverCall({ kind: 'type_text', text: 'x', delayMs: 5000 }, full)!;
    expect(huge.args.delay_ms).toBe(200);
  });

  it('scroll maps positive delta to up and negative to down', () => {
    expect(buildDriverCall({ kind: 'scroll', delta: 5 }, full)!.args).toMatchObject({
      by: 'line',
      direction: 'up',
      amount: 5,
    });
    expect(buildDriverCall({ kind: 'scroll', delta: -3 }, full)!.args).toMatchObject({
      direction: 'down',
      amount: 3,
    });
    // amount clamped 1–50, delta 0 still maps to 1 notch (engine skips 0)
    expect(buildDriverCall({ kind: 'scroll', delta: 0 }, full)!.args.amount).toBe(1);
    expect(buildDriverCall({ kind: 'scroll', delta: 500 }, full)!.args.amount).toBe(50);
  });

  it('bare keys use press_key; combos with modifiers use hotkey with repeats', () => {
    const bare = buildDriverCall({ kind: 'press_key', combo: 'enter', times: 2 }, full)!;
    expect(bare.tool).toBe('press_key');
    expect(bare.args.key).toBe('return');
    expect(bare.repeats).toBe(2);

    const combo = buildDriverCall({ kind: 'press_key', combo: 'ctrl+shift+s' }, full)!;
    expect(combo.tool).toBe('hotkey');
    expect(combo.args).toMatchObject({
      keys: ['ctrl', 'shift', 's'],
      scope: 'desktop',
    });
  });

  it('drag builds screen-absolute from/to and forwards steps when given', () => {
    const call = buildDriverCall(
      { kind: 'drag', fromX: 10, fromY: 20, toX: 430, toY: 88, steps: 12 },
      full,
    )!;
    expect(call.tool).toBe('drag');
    expect(call.args).toMatchObject({
      from_x: 10,
      from_y: 20,
      to_x: 430,
      to_y: 88,
      steps: 12,
      scope: 'desktop',
    });
    // steps omitted → driver's own default
    const plain = buildDriverCall({ kind: 'drag', fromX: 0, fromY: 0, toX: 1, toY: 1 }, full)!;
    expect(plain.args.steps).toBeUndefined();
  });

  it('get_cursor_position is a session-scoped read', () => {
    const call = buildDriverCall({ kind: 'get_cursor_position' }, full)!;
    expect(call.tool).toBe('get_cursor_position');
    expect(call.args).toEqual({ session: 'spirit' });
  });

  it('returns null when the driver lacks the tool (per-action native fallback)', () => {
    expect(buildDriverCall({ kind: 'click', x: 5, y: 5, count: 1 }, empty)).toBeNull();
    expect(buildDriverCall({ kind: 'type_text', text: 'x' }, clicksOnly)).toBeNull();
    expect(buildDriverCall({ kind: 'scroll', delta: 1 }, clicksOnly)).toBeNull();
    expect(
      buildDriverCall({ kind: 'drag', fromX: 0, fromY: 0, toX: 1, toY: 1 }, noDrag),
    ).toBeNull();
    expect(
      buildDriverCall({ kind: 'press_key', combo: 'ctrl+s' }, noHotkey),
    ).toBeNull(); // needs hotkey
    expect(buildDriverCall({ kind: 'get_cursor_position' }, empty)).toBeNull();
  });

  it('a combo the driver cannot represent returns null → native handles it', () => {
    expect(buildDriverCall({ kind: 'press_key', combo: 'ctrl' }, full)).toBeNull();
    expect(buildDriverCall({ kind: 'press_key', combo: 'capslock' }, full)).toBeNull();
  });

  it('honors the foreground delivery override', () => {
    const call = buildDriverCall({ kind: 'click', x: 1, y: 2, count: 1 }, full, 'foreground')!;
    expect(call.args.delivery_mode).toBe('foreground');
  });
});