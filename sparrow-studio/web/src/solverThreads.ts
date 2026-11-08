// rayon-core 1.13 uses 8 bits for thread counters on wasm32.
export const MAX_SOLVER_THREADS = 255;
export const SOLVER_THREADS_ERROR = `Enter a whole number from 1 to ${MAX_SOLVER_THREADS}.`;

export function isManualThreadCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SOLVER_THREADS;
}

export function parseManualThreadCount(text: string): number | undefined {
  const trimmed = text.trim();
  const count = Number(trimmed);
  return /^\d+$/.test(trimmed) && isManualThreadCount(count) ? count : undefined;
}
