export const defaultMockTimeMs = Date.parse("2026-01-01T00:00:00.000Z");

/** Return a stable ISO timestamp for deterministic mock reporting records. */
export function mockIso(timeMs = defaultMockTimeMs): string {
  return new Date(timeMs).toISOString();
}
