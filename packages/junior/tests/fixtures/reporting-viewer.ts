import type { User } from "@sentry/junior-plugin-api";

/** Build a minimal reporting viewer for SQL access checks. */
export function reportingViewer(email: string): User {
  return {
    email,
    id: `viewer:${email.trim().toLowerCase()}`,
    identities: [],
  };
}
