// A session opened from `?session=` before omp flushed its JSONL has no list
// entry yet (typically it appears within a second or two of the first prompt),
// so the lookup is retried for a bounded window: 8 retries at 1 s cover it
// without hanging on a dead link forever.
export const INITIAL_RESTORE_RETRY_MS = 1000;
export const INITIAL_RESTORE_MAX_ATTEMPTS = 8;

export type RestoreStep = { readonly action: "retry"; readonly delayMs: number } | { readonly action: "give-up" };

/** What to do after the `failedLookups`-th lookup (1-based) found nothing. */
export function nextRestoreStep(failedLookups: number): RestoreStep {
  return failedLookups <= INITIAL_RESTORE_MAX_ATTEMPTS
    ? { action: "retry", delayMs: INITIAL_RESTORE_RETRY_MS }
    : { action: "give-up" };
}
