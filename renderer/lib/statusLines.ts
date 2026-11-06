// Rotating status lines shown in the prompt pill while the agent works.
// The pill swaps to a random phrase every STATUS_ADVANCE_MS so the user
// always has a live, personality-driven sense of progress instead of
// static dots. Near-completion phrases live in NEAR_DONE_PHRASES and only
// enter the pool once the run has been going for NEAR_DONE_AFTER_MS, so
// "almost done" type messages appear later, not right away.
export const STATUS_ADVANCE_MS = 1800;
export const NEAR_DONE_AFTER_MS = 12000;

export const STATUS_PHRASES: string[] = [
  'thinking...',
  'your command been followed...',
  'executing now...',
  'waking up the neurons...',
  'sharpening the cursor...',
  'connecting the dots...',
  'brewing your answer...',
  'the machines are thinking...',
  'just a second...',
  'loading your response...',
  'feeding the oracle...',
  'polishing the answer...',
  'reading your screen...',
  'whispering to the models...',
  'summoning the AI...',
  'drafting brilliance...',
  'checking the pixels...',
  'syncing with the void...',
  'your wish is my command...',
  'warming up the circuits...',
  'computing the meaning of life...',
  'in deep thought...',
  'gathering intelligence...',
  'the bots are plotting...',
  'assembling the reply...',
  'cross-checking the universe...',
  'one more second...',
  'stretching the neurons...',
  'channeling the oracle...',
  'decoding your intent...',
  'on it boss...',
  'making it snappy...',
  'the AI is on it...',
  'hotwiring the answer...',
  'thinking real hard...',
  'downloading wisdom...',
  'rendering the reply...',
  'the model is cooking...',
  'done in a jiffy...',
  'running the numbers...',
  'the AI says hold on...',
];

// Completion-flavored lines. Only selectable once NEAR_DONE_AFTER_MS has
// elapsed, and weighted double in the pool so they surface reliably as the
// run winds down.
export const NEAR_DONE_PHRASES: string[] = [
  'almost done... just a few pixels away...',
  'almost there...',
  'just finishing up...',
  'wrapping the response...',
  'a few pixels to go...',
  'finalizing the magic...',
  'almost done...',
  'perfecting your answer...',
  'done... almost...',
];
