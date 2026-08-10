import type { StoredSlackActor } from "@/chat/actor";
import type { IdentityUpsert } from "@/chat/identities/identity";
import type { Conversation, ConversationSource } from "../store";
import type { juniorIdentities } from "@/db/schema";

type IdentityRow = typeof juniorIdentities.$inferSelect;

/** Build a durable identity observation from a stored conversation actor. */
export function identityFromActor(
  actor: StoredSlackActor | undefined,
): IdentityUpsert | undefined {
  if (actor?.slackUserId) {
    return {
      kind: "user",
      provider: "slack",
      providerTenantId: actor.teamId,
      providerSubjectId: actor.slackUserId,
      ...(actor.fullName ? { displayName: actor.fullName } : {}),
      ...(actor.slackUserName ? { handle: actor.slackUserName } : {}),
      ...(actor.email ? { email: actor.email, emailVerified: true } : {}),
      metadata: { platform: "slack" },
    };
  }
  // Dashboard/API actors store a verified email without a Slack subject.
  const email = actor?.email?.trim().toLowerCase();
  if (!email) {
    return undefined;
  }
  return {
    kind: "user",
    provider: "junior",
    providerSubjectId: email,
    email,
    emailVerified: true,
    ...(actor?.fullName ? { displayName: actor.fullName } : {}),
    metadata: { platform: "api" },
  };
}

/** Build a system identity when a conversation has no user actor. */
export function systemIdentityFromSource(
  source: ConversationSource | undefined,
): IdentityUpsert | undefined {
  if (source === "scheduler") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "scheduler",
      displayName: "Junior Scheduler",
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
  if (source === "resource_event") {
    return {
      kind: "system",
      provider: "junior",
      providerSubjectId: "resource-event",
      displayName: "Resource Event",
    };
  }
  return undefined;
}

/** Prefer the user actor identity, else a source-derived system identity. */
export function actorIdentityForConversation(
  conversation: Conversation,
): IdentityUpsert | undefined {
  return (
    identityFromActor(conversation.actor) ??
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
      ...(email ? { email } : {}),
      ...(fullName ? { fullName } : {}),
      platform: "slack",
      slackUserId: identity.providerSubjectId,
      ...(identity.handle ? { slackUserName: identity.handle } : {}),
      ...(identity.providerTenantId ? { teamId: identity.providerTenantId } : {}),
    };
  }
  // Dashboard/API actors are junior identities keyed by verified email.
  if (identity.provider === "junior" && email) {
    return {
      email,
      ...(fullName ? { fullName } : {}),
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
      : {}),
    ...((current.fullName ?? next.fullName)
      ? { fullName: current.fullName ?? next.fullName }
      : {}),
    ...((current.platform ?? next.platform)
      ? { platform: current.platform ?? next.platform }
      : {}),
    ...((current.slackUserId ?? next.slackUserId)
      ? { slackUserId: current.slackUserId ?? next.slackUserId }
      : {}),
    ...((current.slackUserName ?? next.slackUserName)
      ? { slackUserName: current.slackUserName ?? next.slackUserName }
      : {}),
    ...((current.teamId ?? next.teamId)
      ? { teamId: current.teamId ?? next.teamId }
      : {}),
  };
}
