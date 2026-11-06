import { describe, expect, it } from 'vitest';
import {
  cursorFromResult,
  isBackgroundUnavailable,
  nextDeliveryMode,
  parseVerdict,
  pickEngine,
  resultText,
  wantsForegroundRetry,
  type DriverResult,
} from '../electron/input/engine-decision';

describe('pickEngine', () => {
  it('prefers the driver when enabled, present and healthy', () => {
    expect(
      pickEngine({ disabled: false, binaryFound: true, handshakeOk: true }),
    ).toBe('cua-driver');
  });

  it('falls back to native when any prerequisite is missing', () => {
    expect(pickEngine({ disabled: true, binaryFound: true, handshakeOk: true })).toBe('native');
    expect(pickEngine({ disabled: false, binaryFound: false, handshakeOk: true })).toBe('native');
    expect(pickEngine({ disabled: false, binaryFound: true, handshakeOk: false })).toBe('native');
  });
});

describe('resultText', () => {
  it('concatenates content text and structured error', () => {
    const result: DriverResult = {
      content: [{ type: 'text', text: 'head ' }, { text: 'tail' }],
      structuredContent: { error: 'boom' },
    };
    expect(resultText(result)).toBe('head  tail boom');
  });

  it('is empty when there is nothing', () => {
    expect(resultText({})).toBe('');
  });
});

describe('isBackgroundUnavailable', () => {
  it('detects the marker in content text', () => {
    expect(
      isBackgroundUnavailable({
        isError: true,
        content: [{ text: 'background_unavailable: PostMessage dropped by target' }],
      }),
    ).toBe(true);
  });

  it('detects the marker in structuredContent', () => {
    expect(isBackgroundUnavailable({ isError: true, structuredContent: { kind: 'background_unavailable' } })).toBe(
      true,
    );
  });

  it('does not fire on unrelated errors', () => {
    expect(isBackgroundUnavailable({ isError: true, content: [{ text: 'target pid 5 has no on-screen window' }] })).toBe(
      false,
    );
  });
});

describe('nextDeliveryMode', () => {
  const backgroundUnavailable: DriverResult = {
    isError: true,
    structuredContent: { error: 'background_unavailable: switch to foreground' },
  };

  it('escalates the first failure to foreground', () => {
    expect(nextDeliveryMode(0, backgroundUnavailable)).toBe('foreground');
  });

  it('never retries after one escalation', () => {
    expect(nextDeliveryMode(1, backgroundUnavailable)).toBeNull();
  });

  it('never retries a plain error', () => {
    expect(nextDeliveryMode(0, { isError: true, content: [{ text: 'no such element' }] })).toBeNull();
  });

  it('never retries a successful result', () => {
    expect(nextDeliveryMode(0, { isError: false, content: [{ text: 'clicked' }] })).toBeNull();
  });

  it('escalates on a structured foreground verdict', () => {
    expect(
      nextDeliveryMode(0, {
        structuredContent: { effect: 'unverifiable', escalation: { recommended: 'foreground' } },
      }),
    ).toBe('foreground');
  });

  it('does not escalate on a px/page verdict (caller handles those)', () => {
    expect(
      nextDeliveryMode(0, {
        structuredContent: { effect: 'suspected_noop', escalation: { recommended: 'px' } },
      }),
    ).toBeNull();
  });
});

describe('parseVerdict', () => {
  it('reads a full structured verdict', () => {
    expect(
      parseVerdict({
        structuredContent: {
          effect: 'confirmed',
          escalation: { recommended: 'px', reason: 'canvas target' },
          code: 'stale',
          verified: true,
        },
      }),
    ).toEqual({
      effect: 'confirmed',
      escalation: 'px',
      escalationReason: 'canvas target',
      code: 'stale',
      verified: true,
    });
  });

  it('accepts a string escalation and unknown effects', () => {
    expect(
      parseVerdict({ structuredContent: { effect: 'weird', escalation: 'foreground' } }),
    ).toEqual({
      effect: 'unknown',
      escalation: 'foreground',
      escalationReason: null,
      code: null,
      verified: false,
    });
  });

  it('defaults to unknown on empty results', () => {
    expect(parseVerdict({})).toEqual({
      effect: 'unknown',
      escalation: null,
      escalationReason: null,
      code: null,
      verified: false,
    });
  });
});

describe('wantsForegroundRetry', () => {
  it('fires on legacy background_unavailable and verdict codes', () => {
    expect(
      wantsForegroundRetry({ structuredContent: { code: 'background_unavailable' } }),
    ).toBe(true);
    expect(wantsForegroundRetry({ content: [{ text: 'background_unavailable' }] })).toBe(true);
  });

  it('stays quiet on confirmed verdicts without escalation', () => {
    expect(wantsForegroundRetry({ structuredContent: { effect: 'confirmed' } })).toBe(false);
  });
});

describe('cursorFromResult', () => {
  it('reads the point from structuredContent', () => {
    expect(cursorFromResult({ structuredContent: { x: 12, y: 34 } })).toEqual({ x: 12, y: 34 });
  });

  it('reads the point from top-level result fields', () => {
    expect(cursorFromResult({ x: 100, y: 240 })).toEqual({ x: 100, y: 240 });
  });

  it('returns null when the point is missing or non-numeric', () => {
    expect(cursorFromResult({})).toBeNull();
    expect(cursorFromResult({ structuredContent: { x: 'a', y: 4 } })).toBeNull();
    expect(cursorFromResult(null)).toBeNull();
  });
});