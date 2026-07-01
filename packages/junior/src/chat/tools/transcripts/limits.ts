import { MAX_LIMIT, MAX_SCAN_LIMIT } from "@/chat/tools/transcripts/constants";

/** Clamp a model-supplied count to the supported transcript result range. */
export function limit(
  value: number | undefined,
  fallback: number,
  max = MAX_LIMIT,
) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

/** Clamp a model-supplied transcript message offset to a non-negative integer. */
export function offset(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/** Pick the bounded SQL conversation scan window for visible transcript results. */
export function scanLimit(resultLimit: number) {
  return Math.min(MAX_SCAN_LIMIT, Math.max(100, resultLimit * 10));
}
