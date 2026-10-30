import type { StoredSlackActor } from "@/chat/actor";
import { identityForActor, systemIdentity } from "@/chat/identities/actor";
import type { IdentityUpsert } from "@/chat/identities/identity";
import type { Conversation, ConversationSource } from "../store";
import type { juniorIdentities } from "@/db/schema";

type IdentityRow = typeof juniorIdentities.$inferSelect;

/**
 * Read the Identity key of an Actor in the stored Conversation shape.
 *
 * TODO(dcramer): Remove after Conversations store the Identity id instead of
 * StoredSlackActor.
 */
function identityForStoredActor(
  actor: StoredSlackActor | undefined,
): IdentityUpsert | undefined {
  if (actor?.slackUserId) {
    return identityForActor({
      ...(actor.email ? { email: actor.email } : undefined),
      ...(actor.fullName ? { fullName: actor.fullName } : undefined),
      platform: "slack",
      // Older stored Slack actors can omit the team. SQL stores a missing
      // tenant as an empty string.
      teamId: actor.teamId ?? "",
      userId: actor.slackUserId,
      ...(actor.slackUserName ? { userName: actor.slackUserName } : undefined),
    });
  }
  if (!actor?.email) {
    return undefined;
  }
  // A stored web actor keeps only its verified email and name. The web
  // Identity key does not use the Actor user id.
  return identityForActor({
    email: actor.email,
    ...(actor.fullName ? { fullName: actor.fullName } : undefined),
    platform: "web",
    userId: actor.email,
  });
}

/**
 * Build a system identity when a conversation has no user actor.
 *
 * TODO(dcramer): These names do not match the SystemActor names. The
 * scheduler source uses `scheduler`, but its SystemActor is
 * `scheduled-automation`. Other SystemActors use plugin names, `event`,
 * `conversation-title`, and `workspace-snapshot`. Align them when every
 * ingress supplies its Actor.
 */
export function systemIdentityFromSource(
  source: ConversationSource | undefined,
): IdentityUpsert | undefined {
  if (source === "scheduler") {
    return systemIdentity("scheduler", "Scheduler");
  }
  if (source === "local") {
    return systemIdentity("local-cli", "Local CLI");
  }
  if (source === "event") {
    return systemIdentity("event", "Event");
  }
  return undefined;
}

/** Prefer the user actor identity, else a source-derived system identity. */
export function actorIdentityForConversation(
  conversation: Conversation,
): IdentityUpsert | undefined {
  return (
    identityForStoredActor(conversation.actor) ??
    systemIdentityFromSource(conversation.source)
  );
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
