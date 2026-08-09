/** Retain conversation caches while their ownership is being classified. */
export const JUNIOR_THREAD_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Match active processing control to the longest supported paused-turn window. */
export const JUNIOR_PROCESSING_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Keep an empty terminal marker briefly so legacy processing stays masked. */
export const JUNIOR_TERMINAL_PROCESSING_STATE_TTL_MS = 60 * 60 * 1000;

/** Match a sandbox reference to the default resumable sandbox lifetime. */
export const JUNIOR_SANDBOX_REF_TTL_MS = 30 * 60 * 1000;
