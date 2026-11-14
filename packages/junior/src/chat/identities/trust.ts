/**
 * Trust: whether Junior accepts an author's words as their instruction.
 *
 * This module is the one owner of that decision, for every ingress. Slack
 * ingress, Identity dispatch, and Event ingest report what they know about an
 * author and call it. They never decide trust themselves, and plugins only
 * report facts (`EventAuthor`). It reads its own config: the allowed email
 * domains and the Slack bot users that `createApp` lists, and the Slack
 * workspace of the bot.
 *
 * An Event author resolves like a Slack author: a trusted person becomes
 * the author of the Event's Message, and nothing downstream decides again.
 */
import type { StateAdapter } from "chat";
import type { Event, SlackActor } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { resolveBotSlackTeamId } from "@/chat/events/workspace";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { isNativeIdentityProvider } from "@/chat/identities/identity";
import {
  findLinkedSlackUser,
  findSlackUserByPrimaryEmail,
  type LinkedSlackUser,
} from "@/chat/identities/sql";
import { logException, logWarn } from "@/chat/logging";
import { parseSlackUserId } from "@/chat/slack/ids";
import { slackMention } from "@/chat/slack/mrkdwn";
import {
  lookupActiveSlackWorkspaceMember,
  lookupSlackUserProfile,
  type SlackUserProfile,
} from "@/chat/slack/users";
import { createCache } from "@/chat/state/cache";

/** The `createApp` settings that decide who is trusted. */
export interface TrustConfig {
  /** Slack bot users that are trusted without a profile email. */
  allowedBotUserIds: readonly string[];
  /** Email domains of trusted people. An empty list allows every domain. */
  allowedDomains: readonly string[];
}

let trustConfig: TrustConfig = { allowedBotUserIds: [], allowedDomains: [] };

/** Apply the trust settings of one app. Return the previous settings. */
export function setTrustConfig(next: TrustConfig): TrustConfig {
  const previous = trustConfig;
  trustConfig = {
    allowedBotUserIds: [...next.allowedBotUserIds],
    allowedDomains: [...next.allowedDomains],
  };
  return previous;
}

/**
 * Return whether an email, or a bare domain such as Google's `hd` claim, is
 * on the allowed domains. `ifNoDomains` says what an empty list means: Slack
 * authors allow every domain, and sign-ins allow none.
 */
export function isAllowedEmail(
  emailOrDomain: string | undefined,
  options: {
    allowedDomains: readonly string[];
    ifNoDomains: "allow" | "deny";
  },
): boolean {
  if (options.allowedDomains.length === 0) {
    return options.ifNoDomains === "allow";
  }
  const normalized = emailOrDomain?.trim().toLowerCase() ?? "";
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  return Boolean(domain) && options.allowedDomains.includes(domain);
}

/** Why core does not trust an author. */
type UntrustedReason =
  | "check_failed"
  | "core_provider"
  | "domain_not_allowed"
  | "email_changed"
  | "inactive_member"
  | "no_single_link"
  | "no_workspace"
  | "unknown_author";

type Decision =
  | { trusted: true; actor?: SlackActor; user?: LinkedSlackUser["user"] }
  | { trusted: false; reason: UntrustedReason };

// Core owns native identities and the email-keyed `junior` web identities.
// They are not accounts from a plugin's OAuth account-linking flow, so they
// never match.
function isCoreIdentityProvider(provider: string): boolean {
  return provider === "junior" || isNativeIdentityProvider(provider);
}

function isSlackProfileDomainAllowed(profile: SlackUserProfile): boolean {
  const email = profile.email?.trim();
  // A bare domain is not an email, so it never passes here.
  const allowed = isAllowedEmail(email?.includes("@") ? email : undefined, {
    allowedDomains: trustConfig.allowedDomains,
    ifNoDomains: "allow",
  });
  if (!allowed) {
    // A Slack app without `users:read.email` sees no email and blocks all.
    logWarn("slack.allowed_domain.rejected", {
      "app.reason": email ? "domain_not_allowed" : "missing_email",
    });
  }
  return allowed;
}

/**
 * Accept one stored Slack link only when it is a current human member of the
 * workspace whose Slack email is on the allowed domains. With `email`, the
 * Slack email must also still be that address, so a stale stored email does
 * not match.
 */
async function linkedMemberDecision(args: {
  email?: string;
  linked: LinkedSlackUser | undefined;
  teamId: string;
}): Promise<Decision> {
  const userId = parseSlackUserId(args.linked?.slackUserId);
  if (!args.linked || !userId) {
    return { trusted: false, reason: "no_single_link" };
  }
  const member = await lookupActiveSlackWorkspaceMember(userId, args.teamId);
  if (!member) return { trusted: false, reason: "inactive_member" };
  if (args.email && member.email?.trim().toLowerCase() !== args.email) {
    return { trusted: false, reason: "email_changed" };
  }
  if (!isSlackProfileDomainAllowed(member)) {
    return { trusted: false, reason: "domain_not_allowed" };
  }
  return {
    trusted: true,
    actor: { platform: "slack", teamId: args.teamId, userId },
    user: args.linked.user,
  };
}

/**
 * A plugin account is trusted when the plugin lists it, or through its exact
 * `subjectId`, linked by the OAuth account-linking flow to one Slack user who
 * is a current human member on the allowed domains. Handles, emails, and
 * display names never match.
 */
async function accountDecision(args: {
  listed: boolean;
  provider: string;
  subjectId?: string;
}): Promise<Decision> {
  if (isCoreIdentityProvider(args.provider)) {
    return { trusted: false, reason: "core_provider" };
  }
  if (args.listed) return { trusted: true };
  if (!args.subjectId) return { trusted: false, reason: "unknown_author" };
  const teamId = await resolveBotSlackTeamId();
  if (!teamId) return { trusted: false, reason: "no_workspace" };
  return await linkedMemberDecision({
    linked: await findLinkedSlackUser(getSqlExecutor(), {
      provider: args.provider,
      providerSubjectId: args.subjectId,
      slackTeamId: teamId,
    }),
    teamId,
  });
}

// Like workspace membership: avoid a lookup per message, and let a changed
// profile email apply within five minutes.
const SLACK_TRUSTED_TTL_MS = 5 * 60 * 1000;
const SLACK_UNTRUSTED_TTL_MS = 30 * 1000;

/**
 * Return whether a Slack author may start a Turn. The caller must have
 * checked that the author is a member of the workspace `teamId`. A member is
 * trusted when their Slack email is on the allowed domains, or when the app
 * lists them as a bot user. Without allowed domains, every member is.
 */
export async function isTrustedSlackAuthor(args: {
  state: StateAdapter;
  teamId: string | undefined;
  user: unknown;
}): Promise<boolean> {
  const userId = parseSlackUserId(args.user);
  if (!userId || !args.teamId) return false;
  const { allowedBotUserIds, allowedDomains } = trustConfig;
  if (allowedBotUserIds.includes(userId) || allowedDomains.length === 0) {
    return true;
  }
  return await createCache(args.state, "core").getOrLoad(
    `slack:allowed-domain:${args.teamId}:${userId}`,
    async () => {
      // Slack verifies the profile email, so Junior trusts it.
      const profile = await lookupSlackUserProfile(userId);
      const trusted =
        profile.id === userId && isSlackProfileDomainAllowed(profile);
      return {
        value: trusted,
        ttlMs: trusted ? SLACK_TRUSTED_TTL_MS : SLACK_UNTRUSTED_TTL_MS,
      };
    },
  );
}

/**
 * Find the trusted person behind an account of a plugin's provider or behind
 * a verified email, for work that runs as that person. A verified email is
 * trusted when it is the primary email of the User of one Slack member on
 * the allowed domains, and Slack still shows that email. Slack and storage
 * errors propagate.
 */
export async function findTrustedUser(
  author: { provider: string; subjectId: string } | { verifiedEmail: string },
): Promise<
  | { status: "trusted"; user: LinkedSlackUser["user"] }
  | { status: "untrusted"; reason: string }
> {
  let decision: Decision;
  if ("subjectId" in author) {
    decision = await accountDecision({ ...author, listed: false });
  } else {
    const teamId = await resolveBotSlackTeamId();
    const email = author.verifiedEmail.trim().toLowerCase();
    decision = teamId
      ? await linkedMemberDecision({
          email,
          linked: await findSlackUserByPrimaryEmail(getSqlExecutor(), {
            normalizedEmail: email,
            slackTeamId: teamId,
          }),
          teamId,
        })
      : { trusted: false, reason: "no_workspace" };
  }
  if (!decision.trusted)
    return { status: "untrusted", reason: decision.reason };
  // Both author kinds above resolve through a User.
  return decision.user
    ? { status: "trusted", user: decision.user }
    : { status: "untrusted", reason: "no_single_link" };
}

/** Facts about an Event author that core shows, from the plugin report. */
interface EventAuthorFacts {
  bot?: true;
  handle: string;
  /** Provider namespace of the Event. */
  provider: string;
  /** The author's own text, without what they quote. */
  text?: string;
}

/**
 * Core's decision for the author of one Event. A `system` Event has no
 * author. A `trusted` author's own text is their message: a linked person
 * has the Slack Actor and Identity that write it, and a listed bot has
 * neither. An `untrusted` author's text is context.
 */
export type AuthorTrust =
  | { status: "system" }
  | (EventAuthorFacts & {
      status: "trusted";
      actor?: SlackActor;
      identityId?: string;
    })
  | (EventAuthorFacts & { status: "untrusted"; reason: UntrustedReason });

/**
 * Resolve the author of an Event, the same way Slack ingress resolves a
 * Slack author. It never throws: a failed check gives an untrusted author,
 * so the Event still runs and the author's text stays context.
 */
export async function resolveEventAuthor(event: Event): Promise<AuthorTrust> {
  const author = event.author;
  if (!author) return { status: "system" };
  const facts: EventAuthorFacts = {
    ...(author.bot ? { bot: true as const } : undefined),
    handle: author.handle,
    provider: event.namespace,
    ...(author.text?.trim() ? { text: author.text.trim() } : undefined),
  };
  try {
    const decision = await accountDecision({
      listed: author.trusted === true,
      // An Event names an author only on the provider that published it.
      provider: event.namespace,
      ...(author.subjectId ? { subjectId: author.subjectId } : undefined),
    });
    if (!decision.trusted) {
      return { status: "untrusted", reason: decision.reason, ...facts };
    }
    if (!decision.actor) return { status: "trusted", ...facts };
    return {
      status: "trusted",
      actor: decision.actor,
      identityId: await resolveActorIdentityId(
        getSqlExecutor(),
        decision.actor,
      ),
      ...facts,
    };
  } catch (error) {
    logException(error, "event.author.trust_check_failed", {
      "app.event.event_type": event.eventType,
      "app.event.namespace": event.namespace,
    });
    return { status: "untrusted", reason: "check_failed", ...facts };
  }
}

// Handles come from a plugin. Keep a label to one line of ID characters, so
// it cannot open a tag or start another labeled line.
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:@/#+[\]-]/g, "_");
}

/**
 * The one label for an Event author: a Slack mention for a linked person,
 * else the handle and provider.
 */
export function authorLabel(
  author: Exclude<AuthorTrust, { status: "system" }>,
): string {
  if (author.status === "trusted" && author.actor) {
    return slackMention(author.actor.userId);
  }
  return `${safeId(author.handle)} on ${safeId(author.provider)}${author.bot ? " (a bot)" : ""}`;
}
