import type { Actor, StoredSlackActor } from "@/chat/actor";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import type { IdentityUpsert } from "@/chat/identities/identity";
import { upsertIdentity } from "@/chat/identities/sql";
import type { JuniorSqlDatabase } from "@/db/db";
import type { Conversation, ConversationSource } from "../store";
import type { juniorIdentities } from "@/db/schema";

type IdentityRow = typeof juniorIdentities.$inferSelect;

/**
 * Convert an Actor in the stored Conversation shape to a runtime Actor.
 *
 * TODO(dcramer): Remove after Conversations store the Identity id instead of
 * StoredSlackActor.
 */
function actorFromStoredActor(
  actor: StoredSlackActor | undefined,
): Actor | undefined {
  if (actor?.slackUserId) {
    return {
      ...(actor.email ? { email: actor.email } : undefined),
      ...(actor.fullName ? { fullName: actor.fullName } : undefined),
      platform: "slack",
      // Older stored Slack actors can omit the team. SQL stores a missing
      // tenant as an empty string.
      teamId: actor.teamId ?? "",
      userId: actor.slackUserId,
      ...(actor.slackUserName ? { userName: actor.slackUserName } : undefined),
    };
  }
  if (!actor?.email) {
    return undefined;
  }
  // A stored web actor keeps only its verified email and name. The web
  // Identity does not use the Actor user id.
  return {
    email: actor.email,
    ...(actor.fullName ? { fullName: actor.fullName } : undefined),
    platform: "web",
    userId: actor.email,
  };
}

/**
 * Build the legacy system Identity for a Conversation that has no Actor.
 *
 * TODO(dcramer): Remove after every ingress supplies its Actor. These rows use
 * one subject per Source (`scheduler`, `local-cli`, `event`). An Actor
 * uses the one system Identity instead, so the backfill must merge them.
 */
function systemIdentityFromSource(
  source: ConversationSource | undefined,
): IdentityUpsert | undefined {
  if (source === "scheduler") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "scheduler",
      displayName: "Scheduler",
    };
  }
  if (source === "local") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "local-cli",
      displayName: "Local CLI",
    };
  }
  if (source === "event") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "event",
      displayName: "Event",
    };
  }
  return undefined;
}

/**
 * Save the Identity of a Conversation's actor and return its id. Use the
 * legacy source system Identity when the Conversation has no actor.
 */
export async function resolveConversationActorIdentityId(
  executor: JuniorSqlDatabase,
  conversation: Conversation,
): Promise<string | undefined> {
  const actor = actorFromStoredActor(conversation.actor);
  if (actor) {
    return await resolveActorIdentityId(
      executor,
      actor,
      conversation.updatedAtMs,
    );
  }
  const fallback = systemIdentityFromSource(conversation.source);
  return fallback
    ? (await upsertIdentity(executor, fallback, conversation.updatedAtMs)).id
    : undefined;
}

/**
 * Reconstruct a stored actor with the linked user name and identity-scoped
 * provider fields.
 */
export function actorFromIdentityRow(
  identity: IdentityRow | null,
  userDisplayName: string | null,
): StoredSlackActor | undefined {
  if (!identity) {
    return undefined;
  }
  const fullName = userDisplayName?.trim()
    ? userDisplayName
    : identity.displayName;
  const email = identity.emailNormalized ?? identity.email ?? undefined;
  if (identity.provider === "slack") {
    return {
      ...(email ? { email } : undefined),
      ...(fullName ? { fullName } : undefined),
      platform: "slack",
      slackUserId: identity.providerSubjectId,
      ...(identity.handle ? { slackUserName: identity.handle } : undefined),
      ...(identity.providerTenantId
        ? { teamId: identity.providerTenantId }
        : undefined),
    };
  }
  // Dashboard/web actors are junior identities keyed by verified email.
  if (identity.provider === "junior" && email) {
    return {
      email,
      ...(fullName ? { fullName } : undefined),
    };
  }
  return undefined;
}

/** Merge later actor observations without replacing a durable Slack subject. */
export function mergeActor(
  current: StoredSlackActor | undefined,
  next: StoredSlackActor | undefined,
): StoredSlackActor | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (
    current.slackUserId &&
    next.slackUserId &&
    current.slackUserId !== next.slackUserId
  ) {
    return current;
  }
  return {
    ...current,
    ...((current.email ?? next.email)
      ? { email: current.email ?? next.email }
      : undefined),
    ...((current.fullName ?? next.fullName)
      ? { fullName: current.fullName ?? next.fullName }
      : undefined),
    ...((current.platform ?? next.platform)
      ? { platform: current.platform ?? next.platform }
      : undefined),
    ...((current.slackUserId ?? next.slackUserId)
      ? { slackUserId: current.slackUserId ?? next.slackUserId }
      : undefined),
    ...((current.slackUserName ?? next.slackUserName)
      ? { slackUserName: current.slackUserName ?? next.slackUserName }
      : undefined),
    ...((current.teamId ?? next.teamId)
      ? { teamId: current.teamId ?? next.teamId }
      : undefined),
  };
}
