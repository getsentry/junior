/**
 * Map runtime Actors to the Identity rows that Junior stores for them.
 *
 * Every write and read path that needs an Actor's Identity uses this module, so
 * the Conversation store, OAuth, the viewer, and message events agree on one
 * key per person.
 */
import type { Actor } from "@/chat/actor";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  normalizeIdentityEmail,
  type IdentityUpsert,
  type StoredIdentity,
} from "./identity";
import { upsertIdentity } from "./sql";

/** Build the `junior` system Identity with one system name. */
export function systemIdentity(
  name: string,
  displayName?: string,
): IdentityUpsert {
  return {
    kind: "system",
    provider: "junior",
    providerSubjectId: name,
    ...(displayName ? { displayName } : undefined),
  };
}

/**
 * Return the Identity key and profile for one runtime Actor.
 *
 * - Slack: the Slack user in its workspace.
 * - Web: the `junior` Identity keyed by the verified email. A web Actor without
 *   an email has no Identity.
 * - Local: no Identity yet.
 * - System: the `junior` system Identity named by the Actor.
 */
export function identityForActor(actor: Actor): IdentityUpsert | undefined {
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
      // TODO(dcramer): Decide which Identity a local CLI user gets. The local
      // runner uses one shared `local-cli` user id for every person.
      return undefined;
    case "system":
      return systemIdentity(actor.name);
  }
}

/**
 * Save the Identity for one runtime Actor and return its id and linked user.
 * Return undefined when the Actor has no Identity.
 */
export async function upsertActorIdentity(
  executor: JuniorSqlDatabase,
  actor: Actor,
  nowMs: number = Date.now(),
): Promise<StoredIdentity | undefined> {
  const identity = identityForActor(actor);
  return identity ? await upsertIdentity(executor, identity, nowMs) : undefined;
}
