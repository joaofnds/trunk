import type { TrunkError } from './invoke.js';

export const remoteState = $state({
  isRunning: false,
  progressLine: '',
  error: null as TrunkError | null,
});
