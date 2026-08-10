import type { User } from "@sentry/junior-plugin-api";

/** Build a canonical viewer for reporting tests that do not need persisted identities. */
export function testViewer(email: string): User {
  return { email, id: `test:${email.trim().toLowerCase()}`, identities: [] };
}
