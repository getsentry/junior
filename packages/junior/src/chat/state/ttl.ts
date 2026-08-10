/** Retain expiring operational Redis records that still use the shared 7d bound. */
export const JUNIOR_THREAD_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bound active thread scratch while a turn is running or paused for auth. */
export const JUNIOR_ACTIVE_THREAD_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Short grace for idle thread scratch (sandbox reuse / terminal diagnostics). */
export const JUNIOR_TERMINAL_THREAD_STATE_TTL_MS = 60 * 60 * 1000;
