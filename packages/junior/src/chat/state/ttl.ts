/** Retain conversation caches while their ownership is being classified. */
export const JUNIOR_THREAD_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bound thread scratch while a turn is still active or paused. */
export const JUNIOR_ACTIVE_THREAD_STATE_TTL_MS = 24 * 60 * 60 * 1000;
