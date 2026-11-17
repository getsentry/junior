/**
 * Calls that one fan-out of independent reads or writes runs at once. Use it
 * with `p-limit` unless a provider rate limit needs a lower cap.
 */
export const FAN_OUT_CONCURRENCY = 8;
