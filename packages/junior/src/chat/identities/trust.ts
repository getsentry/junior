/**
 * The one place that decides whether an author is a Trusted author: a person
 * or account whose words Junior accepts as their instruction. Every ingress
 * reports what it knows about an author in a `TrustAuthor` and calls
 * `decideAuthorTrust`. Plugins report facts and never decide.
 */
import type { SlackActor } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { isNativeIdentityProvider } from "@/chat/identities/identity";
import {
  findLinkedSlackUser,
  findSlackUserByPrimaryEmail,
  type LinkedSlackUser,
} from "@/chat/identities/sql";
import { logWarn } from "@/chat/logging";
import { isAllowedDomain } from "@/chat/sign-in/allowlist";
import { parseSlackUserId, type SlackUserId } from "@/chat/slack/ids";
import {
  lookupActiveSlackWorkspaceMember,
  lookupSlackUserProfile,
  type SlackUserProfile,
} from "@/chat/slack/users";

/** What an ingress knows about who wrote some input. */
export type TrustAuthor =
  /**
   * A Slack user that Slack ingress already proved is a member of the
   * workspace. `listed` is true when `slack.allowedBotUserIds` names them.
   */
  | { kind: "slack_member"; listed: boolean; userId: SlackUserId }
  /**
   * An account of a plugin's provider. `provider` is always the plugin that
   * reports it, never a value that the plugin chose. `listed` is true when
   * the plugin's trusted authors list names the account.
   */
  | { kind: "account"; listed: boolean; provider: string; subjectId?: string }
  /** An address that the caller proved the person sent from. */
  | { kind: "verified_email"; email: string };

/** Why an author is not trusted. */
export type UntrustedAuthorReason =
  | "core_provider"
  | "domain_not_allowed"
  | "email_changed"
  | "inactive_member"
  | "no_single_link"
  | "no_workspace"
  | "unknown_author";

/** The User behind a trusted author who maps to one Slack member. */
type TrustedUser = LinkedSlackUser["user"];

/**
 * A trust decision. A trusted author has a Slack Actor when they map to one
 * Slack member, and a User when core found it through a link or an email. An
 * account that only a trusted authors list names has neither.
 */
export type AuthorTrust =
  | { trusted: true; actor?: SlackActor; user?: TrustedUser }
  | { trusted: false; reason: UntrustedAuthorReason };

// Core owns native identities and the email-keyed `junior` web identities.
// They are not accounts from a plugin's OAuth account-linking flow, so they
// never match.
function isCoreIdentityProvider(provider: string): boolean {
  return provider === "junior" || isNativeIdentityProvider(provider);
}

/** Whether the Slack email of a profile is on the allowed domains. */
function isSlackProfileDomainAllowed(
  profile: SlackUserProfile,
  allowedDomains: readonly string[],
): boolean {
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

function slackActor(teamId: string, userId: SlackUserId): SlackActor {
  return { platform: "slack", teamId, userId };
}

/**
 * Accept one stored Slack link only when it is a current human member of the
 * workspace whose Slack email is on the allowed domains. With `email`, the
 * Slack email must also still be that address, so a stale stored email does
 * not match.
 */
async function linkedMemberTrust(args: {
  allowedDomains: readonly string[];
  email?: string;
  linked: LinkedSlackUser | undefined;
  slackTeamId: string;
}): Promise<AuthorTrust> {
  const slackUserId = parseSlackUserId(args.linked?.slackUserId);
  if (!args.linked || !slackUserId) {
    return { trusted: false, reason: "no_single_link" };
  }
  const member = await lookupActiveSlackWorkspaceMember(
    slackUserId,
    args.slackTeamId,
  );
  if (!member) return { trusted: false, reason: "inactive_member" };
  if (args.email && member.email?.trim().toLowerCase() !== args.email) {
    return { trusted: false, reason: "email_changed" };
  }
  if (!isSlackProfileDomainAllowed(member, args.allowedDomains)) {
    return { trusted: false, reason: "domain_not_allowed" };
  }
  return {
    trusted: true,
    actor: slackActor(args.slackTeamId, slackUserId),
    user: args.linked.user,
  };
}

/**
 * Decide whether an author is a Trusted author.
 *
 * - A listed author is trusted.
 * - A Slack member is trusted when their Slack email is on the allowed
 *   domains. Without allowed domains, every member is.
 * - A plugin account is trusted only through its exact `subjectId`, linked by
 *   the OAuth account-linking flow to one Slack user who is a current human
 *   member on the allowed domains. Handles, emails, and display names never
 *   match.
 * - A verified email is trusted when it is the primary email of the User of
 *   one such member, and Slack still shows that email.
 *
 * Every other author is untrusted. Slack and storage errors propagate.
 */
export async function decideAuthorTrust(
  author: TrustAuthor,
  args: { allowedDomains: readonly string[]; slackTeamId: string | undefined },
): Promise<AuthorTrust> {
  const teamId = args.slackTeamId;
  if (author.kind === "slack_member") {
    if (!teamId) return { trusted: false, reason: "no_workspace" };
    const actor = slackActor(teamId, author.userId);
    if (author.listed || args.allowedDomains.length === 0) {
      return { trusted: true, actor };
    }
    // Slack verifies the profile email, so Junior trusts it.
    const profile = await lookupSlackUserProfile(author.userId);
    return profile.id === author.userId &&
      isSlackProfileDomainAllowed(profile, args.allowedDomains)
      ? { trusted: true, actor }
      : { trusted: false, reason: "domain_not_allowed" };
  }
  if (author.kind === "account") {
    if (isCoreIdentityProvider(author.provider)) {
      return { trusted: false, reason: "core_provider" };
    }
    if (author.listed) return { trusted: true };
    if (!author.subjectId) return { trusted: false, reason: "unknown_author" };
    if (!teamId) return { trusted: false, reason: "no_workspace" };
    return await linkedMemberTrust({
      allowedDomains: args.allowedDomains,
      linked: await findLinkedSlackUser(getSqlExecutor(), {
        provider: author.provider,
        providerSubjectId: author.subjectId,
        slackTeamId: teamId,
      }),
      slackTeamId: teamId,
    });
  }
  if (!teamId) return { trusted: false, reason: "no_workspace" };
  const email = author.email.trim().toLowerCase();
  return await linkedMemberTrust({
    allowedDomains: args.allowedDomains,
    email,
    linked: await findSlackUserByPrimaryEmail(getSqlExecutor(), {
      normalizedEmail: email,
      slackTeamId: teamId,
    }),
    slackTeamId: teamId,
  });
}
