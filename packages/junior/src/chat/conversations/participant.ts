import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { juniorIdentities } from "@/db/schema";

interface ParticipantIdentityColumns {
  emailNormalized: AnyPgColumn;
  emailVerified: AnyPgColumn;
}

function normalizeAuthorizedUserEmail(
  email: string | undefined,
): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

/** Select whether the joined verified actor identity matches the viewer. */
export function participantMatchColumn(
  authorizedUserEmail?: string,
  identity: ParticipantIdentityColumns = juniorIdentities,
) {
  const normalizedEmail = normalizeAuthorizedUserEmail(authorizedUserEmail);
  return sql<boolean>`COALESCE(
    ${identity.emailVerified} = true
      AND ${identity.emailNormalized} = ${normalizedEmail ?? null},
    false
  )`;
}
