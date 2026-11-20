import type { User } from "@sentry/junior-plugin-api";
import { resolveViewerUser } from "@/chat/plugins/viewer";

/** Build a canonical viewer for reporting tests that do not need persisted identities. */
export function testViewer(email: string): User {
  return { email, id: `test:${email.trim().toLowerCase()}`, identities: [] };
}

/**
 * Sign in like the dashboard: resolve or create the persisted User. Access
 * reads Participant rows by User id, so a viewer that must match a
 * Participant needs this, not `testViewer`.
 */
export async function signedInViewer(email: string): Promise<User> {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`Expected a viewer for ${email}`);
  return viewer;
}
