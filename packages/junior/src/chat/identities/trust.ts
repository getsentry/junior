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
 * For an Event, core saves the decision as an `AuthorTrust`. Task input and
 * action review render only that saved value. Nothing downstream decides
 * again.
 */
import type { StateAdapter } from "chat";
import {
  slackActorSchema,
  type Event,
  type SlackActor,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { getSqlExecutor } from "@/chat/db";
import { resolveBotSlackTeamId } from "@/chat/events/workspace";
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

/** Return whether a verified domain may use Junior. An empty list allows all. */
export function isAllowedDomain(
  domain: string | undefined,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  return Boolean(domain && allowedDomains.includes(domain.toLowerCase()));
}

/**
 * Return whether a verified sign-in email is on an allowed domain. Sign-in
 * needs a configured list, so an empty list allows no email.
 */
export function isAllowedSignInEmail(
  email: string,
  allowedDomains: readonly string[],
): boolean {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  return (
    allowedDomains.length > 0 &&
    separator > 0 &&
    isAllowedDomain(normalized.slice(separator + 1), allowedDomains)
  );
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
  const { allowedDomains } = trustConfig;
  if (allowedDomains.length === 0) return true;
  const email = profile.email?.toLowerCase();
  const separator = email?.lastIndexOf("@") ?? -1;
  const domain = separator > 0 ? email?.slice(separator + 1) : undefined;
  const allowed = isAllowedDomain(domain, allowedDomains);
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

const eventAuthorFields = {
  bot: z.literal(true).optional(),
  handle: z.string().min(1),
  /** Provider namespace of the Event. */
  provider: z.string().min(1),
  /** The author's own text, without what they quote. */
  text: z.string().min(1).optional(),
};

/**
 * Core's trust decision for the author of one Event, saved with the Event.
 * A `system` Event has no author. A `trusted` author's text counts as their
 * message. An `untrusted` author's text is context, and core says so.
 */
export const authorTrustSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("system") }).strict(),
  z
    .object({
      status: z.literal("trusted"),
      /** The Slack member behind the author, when core linked one. */
      actor: slackActorSchema.optional(),
      ...eventAuthorFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("untrusted"),
      /** Why core does not trust the author, as an ID. */
      reason: z.string().min(1),
      ...eventAuthorFields,
    })
    .strict(),
]);

export type AuthorTrust = z.output<typeof authorTrustSchema>;

async function decideEventAuthorTrust(event: Event): Promise<AuthorTrust> {
  const author = event.author;
  if (!author) return { status: "system" };
  const facts = {
    ...(author.bot ? { bot: true as const } : undefined),
    handle: author.handle,
    provider: event.namespace,
    ...(author.text?.trim() ? { text: author.text.trim() } : undefined),
  };
  let decision: Decision;
  try {
    decision = await accountDecision({
      listed: author.trusted === true,
      // An Event names an author only on the provider that published it.
      provider: event.namespace,
      ...(author.subjectId ? { subjectId: author.subjectId } : undefined),
    });
  } catch (error) {
    // A failed check gives an Untrusted author: the Event still runs, and
    // the author's text stays context.
    logException(error, "event.author.trust_check_failed", {
      "app.event.event_type": event.eventType,
      "app.event.namespace": event.namespace,
    });
    decision = { trusted: false, reason: "check_failed" };
  }
  if (!decision.trusted) {
    return { status: "untrusted", reason: decision.reason, ...facts };
  }
  return {
    status: "trusted",
    ...(decision.actor ? { actor: decision.actor } : undefined),
    ...facts,
  };
}

/**
 * Return a function that decides the author trust of an Event at most once,
 * when a matching Watch or Event automation first needs it. Events that
 * match nothing need no lookup. It never throws.
 */
export function eventAuthorTrustOnce(event: Event): () => Promise<AuthorTrust> {
  let pending: Promise<AuthorTrust> | undefined;
  return () => (pending ??= decideEventAuthorTrust(event));
}

// Handles come from a plugin. Keep a label to one line of ID characters, so
// it cannot open a tag or start another labeled line.
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:@/#+[\]-]/g, "_");
}

/**
 * The one label for an Event author, in task input and in action review: a
 * Slack mention for a linked person, else the handle and provider.
 */
export function authorLabel(
  trust: Exclude<AuthorTrust, { status: "system" }>,
): string {
  if (trust.status === "trusted" && trust.actor) {
    return slackMention(trust.actor.userId);
  }
  return `${safeId(trust.handle)} on ${safeId(trust.provider)}${trust.bot ? " (a bot)" : ""}`;
}

/** The untrusted reason as a one-line ID, for a tag attribute. */
export function untrustedReasonId(
  trust: Extract<AuthorTrust, { status: "untrusted" }>,
): string {
  return safeId(trust.reason);
}

/**
 * Read the author trust that core saved for the Events of a Turn. Invalid
 * entries are dropped, so a resume never gains authority.
 */
export function parseAuthorTrusts(value: unknown): AuthorTrust[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = authorTrustSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
