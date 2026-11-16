/**
 * Trust: whether Junior accepts an author as the person they say they are.
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
 * An Event author's text is never an instruction. The Watch or Automation
 * that the Event matched gives the job.
 */
import type { StateAdapter } from "chat";
import * as z from "zod";
import type { Event, SlackActor } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import type { TagAuthor } from "@/chat/input-tags";
import { resolveBotSlackTeamId } from "@/chat/events/workspace";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { isNativeIdentityProvider } from "@/chat/identities/identity";
import {
  findLinkedSlackUser,
  findSlackUserByPrimaryEmail,
  type LinkedSlackUser,
} from "@/chat/identities/sql";
import { logException, logWarn } from "@/chat/logging";
import { parseSlackUserId, type SlackUserId } from "@/chat/slack/ids";
import {
  lookupActiveSlackWorkspaceMember,
  lookupSlackUserProfile,
  type SlackUserProfile,
} from "@/chat/slack/users";
import { getStateAdapter } from "@/chat/state/adapter";
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

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

/**
 * Parse a value that must be an email, such as a sign-in or a verified email
 * from a plugin. Return the normalized email and its domain, or undefined
 * when the value is not a valid email.
 */
export function parseEmail(
  value: unknown,
): { email: string; domain: string } | undefined {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const email = parsed.data;
  return { email, domain: email.slice(email.lastIndexOf("@") + 1) };
}

/**
 * Return whether a domain, such as the domain of a parsed email or Google's
 * `hd` claim, is on the allowed domains. It only compares domains.
 * `ifNoDomains` says what an empty list means: Slack authors allow every
 * domain, and sign-ins allow none.
 */
export function isAllowedDomain(
  domain: string | undefined,
  options: {
    allowedDomains: readonly string[];
    ifNoDomains: "allow" | "deny";
  },
): boolean {
  if (options.allowedDomains.length === 0) {
    return options.ifNoDomains === "allow";
  }
  const normalized = domain?.trim().toLowerCase();
  return normalized ? options.allowedDomains.includes(normalized) : false;
}

/** Why core does not trust an author. */
type UntrustedReason =
  | "check_failed"
  | "core_provider"
  | "domain_not_allowed"
  | "email_changed"
  | "inactive_member"
  | "invalid_email"
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

function isSlackProfileDomainAllowed(profile: { email?: string }): boolean {
  // Slack verifies the profile email, so only its domain is read. A person
  // with no email has no domain and is not allowed. Listed bots have no
  // email and are trusted before this check.
  const email = profile.email?.trim();
  const separator = email?.lastIndexOf("@") ?? -1;
  const allowed = isAllowedDomain(
    separator > 0 ? email?.slice(separator + 1) : undefined,
    { allowedDomains: trustConfig.allowedDomains, ifNoDomains: "allow" },
  );
  if (!allowed) {
    // A Slack app without `users:read.email` sees no email and blocks all.
    logWarn("slack.allowed_domain.rejected", {
      "app.reason": email ? "domain_not_allowed" : "missing_email",
    });
  }
  return allowed;
}

// Like workspace membership: avoid a lookup per message, and let a changed
// profile email or a deactivation apply within five minutes.
const SLACK_TRUSTED_TTL_MS = 5 * 60 * 1000;
const SLACK_UNTRUSTED_TTL_MS = 30 * 1000;

/** The fields of an active Slack member that the trust decision reads. */
type ActiveMember = Pick<SlackUserProfile, "email" | "name" | "real_name">;

// Watch ingest, Event automation ingest, and repeated deliveries resolve the
// same author, so cache the lookup like Slack ingress does. Errors are not
// cached.
async function readActiveMember(
  userId: SlackUserId,
  teamId: string,
): Promise<ActiveMember | null> {
  return await createCache(getStateAdapter(), "core").getOrLoad(
    `slack:active-member:${teamId}:${userId}`,
    async () => {
      const member = await lookupActiveSlackWorkspaceMember(userId, teamId);
      const value: ActiveMember | null = member
        ? {
            email: member.email,
            name: member.name,
            real_name: member.real_name,
          }
        : null;
      return {
        value,
        ttlMs: value ? SLACK_TRUSTED_TTL_MS : SLACK_UNTRUSTED_TTL_MS,
      };
    },
  );
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
  const member = await readActiveMember(userId, args.teamId);
  if (!member) return { trusted: false, reason: "inactive_member" };
  if (args.email && member.email?.trim().toLowerCase() !== args.email) {
    return { trusted: false, reason: "email_changed" };
  }
  if (!isSlackProfileDomainAllowed(member)) {
    return { trusted: false, reason: "domain_not_allowed" };
  }
  // The same names as on this person's Slack messages, so their Event
  // text shows the same author.
  const fullName = member.real_name?.trim() || undefined;
  const userName = member.name?.trim() || undefined;
  return {
    trusted: true,
    actor: {
      platform: "slack",
      teamId: args.teamId,
      userId,
      ...(fullName ? { fullName } : undefined),
      ...(userName ? { userName } : undefined),
    },
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

// A verified email must still be a valid email before any lookup.
async function verifiedEmailDecision(value: string): Promise<Decision> {
  const email = parseEmail(value)?.email;
  if (!email) return { trusted: false, reason: "invalid_email" };
  const teamId = await resolveBotSlackTeamId();
  if (!teamId) return { trusted: false, reason: "no_workspace" };
  return await linkedMemberDecision({
    email,
    linked: await findSlackUserByPrimaryEmail(getSqlExecutor(), {
      normalizedEmail: email,
      slackTeamId: teamId,
    }),
    teamId,
  });
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
    decision = await verifiedEmailDecision(author.verifiedEmail);
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
 * author. A `trusted` linked person has the Slack Actor and Identity that
 * write the Event's Message, and a listed bot has neither. An `untrusted`
 * author is shown by handle and marked as not verified.
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

// Handles come from a plugin. Keep a name to one line of ID characters, so
// it cannot open a tag or start another line.
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:@/#+[\]-]/g, "_");
}

/** An Event author's own text and who wrote it, for the task input. */
export interface EventAuthorText extends TagAuthor {
  text: string;
  /** False when core could not verify who the author is. */
  verified: boolean;
}

/**
 * Return an Event author's own text and who wrote it. A linked person has
 * the same author ID and name as on their Slack messages. Other authors
 * show their handle on the provider.
 */
export function eventAuthorText(
  author: AuthorTrust,
): EventAuthorText | undefined {
  if (author.status === "system" || !author.text) return undefined;
  const actor = author.status === "trusted" ? author.actor : undefined;
  const name =
    actor?.fullName ??
    actor?.userName ??
    `${safeId(author.handle)} on ${safeId(author.provider)}${author.bot ? " (a bot)" : ""}`;
  return {
    text: author.text,
    ...(actor ? { authorId: actor.userId } : undefined),
    authorName: name,
    verified: author.status === "trusted",
  };
}
