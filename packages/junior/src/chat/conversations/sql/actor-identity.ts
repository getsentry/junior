import type { StoredSlackActor } from "@/chat/actor";
import { identityForStoredActor } from "@/chat/identities/actor";
import type { IdentityUpsert } from "@/chat/identities/identity";
import { logWarn } from "@/chat/logging";
import type { Conversation, ConversationSource } from "../store";
import type { juniorIdentities } from "@/db/schema";

type IdentityRow = typeof juniorIdentities.$inferSelect;

/** Build a system identity when a conversation has no user actor. */
export function systemIdentityFromSource(
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
 * Prefer the user actor identity, else a source-derived system identity.
 *
 * TODO(dcramer): Remove the source fallback after every ingress supplies an
 * Actor. `conversation.actor.missing` shows the writes that still use it.
 */
export function actorIdentityForConversation(
  conversation: Conversation,
): IdentityUpsert | undefined {
  const identity = identityForStoredActor(conversation.actor);
  if (identity) {
    return identity;
  }
  const fallback = systemIdentityFromSource(conversation.source);
  if (fallback) {
    logWarn("conversation.actor.missing", {
      "app.conversation.source": conversation.source,
    });
  }
  return fallback;
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
