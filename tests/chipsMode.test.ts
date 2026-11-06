import { describe, expect, it } from 'vitest';
import { isChipGenerationEnabled, shouldShowChips } from '../renderer/lib/chipsMode';

describe('shouldShowChips (setting rules everything, pure phase predicate)', () => {
  it('both shows chips in every phase', () => {
    for (const phase of ['voice', 'type'] as const) {
      expect(shouldShowChips('both', phase)).toBe(true);
    }
  });

  it('off hides chips in every phase', () => {
    for (const phase of ['voice', 'type'] as const) {
      expect(shouldShowChips('off', phase)).toBe(false);
    }
  });

  it('voice mode only shows during the mic capsule phase', () => {
    expect(shouldShowChips('voice', 'voice')).toBe(true);
    expect(shouldShowChips('voice', 'type')).toBe(false);
  });

  it('type mode only shows while typing', () => {
    expect(shouldShowChips('type', 'type')).toBe(true);
    expect(shouldShowChips('type', 'voice')).toBe(false);
  });

  it('voice/type-only modes are exclusive per phase', () => {
    for (const mode of ['voice', 'type'] as const) {
      const on = mode === 'voice' ? shouldShowChips(mode, 'voice') || shouldShowChips(mode, 'type') : shouldShowChips(mode, 'type') || shouldShowChips(mode, 'voice');
      expect(on).toBe(true);
      expect(shouldShowChips(mode, mode === 'voice' ? 'type' : 'voice')).toBe(false);
    }
  });
});

describe('isChipGenerationEnabled', () => {
  it('turns generation off only for off', () => {
    expect(isChipGenerationEnabled('off')).toBe(false);
    expect(isChipGenerationEnabled('both')).toBe(true);
    expect(isChipGenerationEnabled('voice')).toBe(true);
    expect(isChipGenerationEnabled('type')).toBe(true);
  });
});