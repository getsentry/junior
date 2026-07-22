import { sql } from "drizzle-orm";
import { juniorIdentities } from "@/db/schema";

/** Normalize the authenticated email used for participant comparisons. */
export function normalizeAuthorizedUserEmail(
  email: string | undefined,
): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

/** Select whether the joined verified actor identity matches the viewer. */
export function participantMatchColumn(authorizedUserEmail?: string) {
  const normalizedEmail = normalizeAuthorizedUserEmail(authorizedUserEmail);
  return sql<boolean>`COALESCE(
    ${juniorIdentities.emailVerified} = true
      AND ${juniorIdentities.emailNormalized} = ${normalizedEmail ?? null},
    false
  )`;
}
