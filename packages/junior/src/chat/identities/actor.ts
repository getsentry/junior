/**
 * Resolve runtime Actors to the Identity rows that Junior stores for them.
 *
 * The Conversation store, OAuth, the viewer, and message events use this
 * module, so they agree on one Identity per person. The key for each Actor
 * stays private here, so it can change without changing callers.
 */
import { and, eq } from "drizzle-orm";
import type { Actor } from "@/chat/actor";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import { juniorIdentities } from "@/db/schema";
import { normalizeIdentityEmail, type IdentityUpsert } from "./identity";
import { upsertIdentity } from "./sql";

/** The one Identity for work that Junior does on its own. */
const SYSTEM_IDENTITY: IdentityUpsert = {
  kind: "system",
  provider: "junior",
  providerSubjectId: "system",
  displayName: "System",
};

/**
 * Return the Identity key for one Actor.
 *
 * Every SystemActor uses the one system Identity. `SystemActor.name` is
 * provenance, not part of the key. A LocalActor uses the system Identity too,
 * because the local runner has no per-person user id.
 */
function identityKey(actor: Actor): IdentityUpsert | undefined {
  switch (actor.platform) {
    case "slack":
      return {
        kind: "user",
        provider: "slack",
        providerTenantId: actor.teamId,
        providerSubjectId: actor.userId,
        ...(actor.fullName ? { displayName: actor.fullName } : undefined),
        ...(actor.userName ? { handle: actor.userName } : undefined),
        ...(actor.email
          ? { email: actor.email, emailVerified: true }
          : undefined),
        metadata: { platform: "slack" },
      };
    case "web": {
      // TODO(dcramer): Look up the viewer User's `google` Identity instead of
      // the `junior/<email>` row.
      const email = normalizeIdentityEmail(actor.email);
      if (!email) {
        return undefined;
      }
      return {
        kind: "user",
        provider: "junior",
        providerSubjectId: email,
        email,
        emailVerified: true,
        ...(actor.fullName ? { displayName: actor.fullName } : undefined),
        metadata: { platform: "web" },
      };
    }
    case "local":
    case "system":
      return SYSTEM_IDENTITY;
  }
}

/**
 * Save the Identity for one Actor and return its id.
 * Return undefined only for a web Actor without a verified email.
 */
export async function resolveActorIdentityId(
  executor: JuniorSqlDatabase,
  actor: Actor,
  nowMs: number = Date.now(),
): Promise<string | undefined> {
  const key = identityKey(actor);
  return key ? (await upsertIdentity(executor, key, nowMs)).id : undefined;
}

/** Find the stored Identity id for one Actor without writing. */
export async function findActorIdentityId(
  db: JuniorDatabase,
  actor: Actor,
): Promise<string | undefined> {
  const key = identityKey(actor);
  if (!key) {
    return undefined;
  }
  const rows = await db
    .select({ id: juniorIdentities.id })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, key.provider),
        eq(juniorIdentities.providerTenantId, key.providerTenantId ?? ""),
        eq(juniorIdentities.providerSubjectId, key.providerSubjectId),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}
