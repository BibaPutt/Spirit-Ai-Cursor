// Wiggle sensitivity tuning table — pure, no imports, unit-tested.
// `high` is the loosest tuning (easily triggered, the default);
// `low` needs a bigger, longer, more deliberate shake.

export interface WiggleTuning {
  windowMs: number;
  amplitudePx: number;
  reversals: number;
}

export const WIGGLE_TUNING_HIGH: WiggleTuning = {
  windowMs: 1100,
  amplitudePx: 45,
  reversals: 3,
};

export function wiggleTuningForLevel(level: string | undefined): WiggleTuning {
  switch (level) {
    case 'low':
      return { windowMs: 800, amplitudePx: 80, reversals: 4 };
    case 'normal':
      return { windowMs: 900, amplitudePx: 60, reversals: 3 };
    case 'high':
    default:
      return { ...WIGGLE_TUNING_HIGH };
  }
}
