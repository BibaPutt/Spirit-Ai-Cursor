// Backwards-compat re-exports so older imports keep working while we migrate
// to the new provider router.
export {
  streamCompletion,
  type StreamHandle,
  type StreamOptions,
} from './providers/router';
export type { StreamHandlers } from './providers/types';
