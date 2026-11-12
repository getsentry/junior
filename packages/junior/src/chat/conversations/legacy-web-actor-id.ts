/**
 * Web Actor ids that Junior stored before web Actors used the User id.
 *
 * Mailbox input, web authorizations, and OAuth credentials saved before that
 * deploy still carry `dashboard:` and the first 24 hex characters of
 * sha256(email).
 *
 * TODO(dcramer): Delete with its callers after that input and those
 * authorizations expire and no `dashboard:` credential keys remain.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { juniorUsers } from "@/db/schema";

// User ids come from randomUUID(). Slack and local ids never match, so a
// lookup for them does not read the database.
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Return the legacy web Actor id for one email. */
export function legacyWebActorUserId(email: string): string {
  const hash = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  return `dashboard:${hash.slice(0, 24)}`;
}

/** Return every web Actor id that names this User, the User id first. */
export function webActorUserIds(user: Pick<User, "email" | "id">): string[] {
  return [user.id, legacyWebActorUserId(user.email)];
}

/** Return the legacy web Actor id of a User id, when the User exists. */
export async function findLegacyWebActorUserId(
  userId: string,
): Promise<string | undefined> {
  if (!USER_ID_PATTERN.test(userId)) return undefined;
  const rows = await getDb()
    .select({ email: juniorUsers.primaryEmailNormalized })
    .from(juniorUsers)
    .where(eq(juniorUsers.id, userId))
    .limit(1);
  return rows[0] ? legacyWebActorUserId(rows[0].email) : undefined;
}
