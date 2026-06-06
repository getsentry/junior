const INTERRUPTED_MARKER = "\n\n[Response interrupted before completion]";

/** Return the marker added when a visible reply ended mid-execution. */
export function getInterruptionMarker(): string {
  return INTERRUPTED_MARKER;
}
