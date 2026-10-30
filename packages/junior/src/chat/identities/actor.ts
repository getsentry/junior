/**
 * Map runtime Actors to the Identity rows that Junior stores for them.
 *
 * Every write and read path that needs an Actor's Identity uses this module, so
 * Slack ingress, web ingress, OAuth, the viewer, and message events agree on
 * one key per person.
 */
import type { Actor, StoredSlackActor } from "@/chat/actor";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  normalizeIdentityEmail,
  type IdentityUpsert,
  type StoredIdentity,
} from "./identity";
import { upsertIdentity } from "./sql";

interface ActorProfile {
  email?: string;
  fullName?: string;
  userName?: string;
}

function slackIdentity(
  teamId: string | undefined,
  userId: string,
  profile: ActorProfile,
): IdentityUpsert {
  return {
    kind: "user",
    provider: "slack",
    providerTenantId: teamId,
    providerSubjectId: userId,
    ...(profile.fullName ? { displayName: profile.fullName } : undefined),
    ...(profile.userName ? { handle: profile.userName } : undefined),
    ...(profile.email
      ? { email: profile.email, emailVerified: true }
      : undefined),
    metadata: { platform: "slack" },
  };
}

/** Web Identities are keyed by the email that dashboard sign-in verified. */
function webIdentity(profile: ActorProfile): IdentityUpsert | undefined {
  const email = normalizeIdentityEmail(profile.email);
  if (!email) {
    return undefined;
  }
  return {
    kind: "user",
    provider: "junior",
    providerSubjectId: email,
    email,
    emailVerified: true,
    ...(profile.fullName ? { displayName: profile.fullName } : undefined),
    metadata: { platform: "web" },
  };
}

/**
 * Return the Identity key and profile for one runtime Actor.
 *
 * - Slack: the Slack user in its workspace.
 * - Web: the `junior` Identity keyed by the verified email. A web Actor without
 *   an email has no Identity.
 * - Local: a `local` user Identity keyed by the local user id. It is not the
 *   "Local CLI" system Identity that the Conversation store uses when a local
 *   Conversation has no Actor.
 * - System: the `junior` system Identity named by the Actor.
 */
export function identityForActor(actor: Actor): IdentityUpsert | undefined {
  switch (actor.platform) {
    case "slack":
      return slackIdentity(actor.teamId, actor.userId, actor);
    case "web":
      return webIdentity(actor);
    case "local":
      return {
        kind: "user",
        provider: "local",
        providerSubjectId: actor.userId,
        ...(actor.fullName ? { displayName: actor.fullName } : undefined),
        ...(actor.userName ? { handle: actor.userName } : undefined),
        metadata: { platform: "local" },
      };
    case "system":
      return {
        kind: "system",
        provider: "junior",
        providerSubjectId: actor.name,
      };
  }
}

/**
 * Return the Identity key for an Actor in the stored Conversation shape.
 *
 * TODO(dcramer): Remove after Conversations store the Identity id instead of
 * StoredSlackActor.
 */
export function identityForStoredActor(
  actor: StoredSlackActor | undefined,
): IdentityUpsert | undefined {
  if (!actor) {
    return undefined;
  }
  if (actor.slackUserId) {
    // Older stored Slack actors can omit the team.
    return slackIdentity(actor.teamId, actor.slackUserId, {
      email: actor.email,
      fullName: actor.fullName,
      userName: actor.slackUserName,
    });
  }
  // Stored web actors keep only the verified email and name.
  return webIdentity(actor);
}

/**
 * Save the Identity for one runtime Actor and return its id and linked user.
 * Return undefined only when the Actor has no Identity key.
 */
export async function upsertActorIdentity(
  executor: JuniorSqlDatabase,
  actor: Actor,
  nowMs: number = Date.now(),
): Promise<StoredIdentity | undefined> {
  const identity = identityForActor(actor);
  return identity ? await upsertIdentity(executor, identity, nowMs) : undefined;
}
