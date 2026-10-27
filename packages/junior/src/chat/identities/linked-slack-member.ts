import { getSqlExecutor } from "@/chat/db";
import { isNativeIdentityProvider } from "@/chat/identities/identity";
import { findLinkedSlackUserId } from "@/chat/identities/sql";
import { isSlackProfileDomainAllowed } from "@/chat/ingress/slack-allowed-domain";
import { parseSlackUserId, type SlackUserId } from "@/chat/slack/ids";
import { lookupActiveSlackWorkspaceMember } from "@/chat/slack/users";

/** Why a provider Identity does not belong to a current linked Slack member. */
export type LinkedSlackMemberMiss =
  | "core_provider"
  | "no_single_link"
  | "inactive_member"
  | "domain_not_allowed";

// Core owns native identities and the email-keyed `junior` web identities.
// They are not accounts from a plugin's OAuth account-linking flow, so they
// never match.
function isCoreIdentityProvider(provider: string): boolean {
  return provider === "junior" || isNativeIdentityProvider(provider);
}

/**
 * Find the Slack user behind one exact provider account, as Slack ingress
 * would accept them now.
 *
 * Only the provider account id that the OAuth account-linking flow stored
 * matches. Handles, emails, and display names never match. The account must
 * link to exactly one Slack user in the workspace. That user must be a
 * current human member, and their Slack email must be on the allowed domains.
 * Slack and storage errors propagate.
 */
export async function findLinkedSlackMember(args: {
  allowedDomains: readonly string[];
  provider: string;
  providerSubjectId: string;
  slackTeamId: string;
}): Promise<
  | { status: "linked"; slackUserId: SlackUserId }
  | { status: "not_linked"; reason: LinkedSlackMemberMiss }
> {
  if (isCoreIdentityProvider(args.provider)) {
    return { status: "not_linked", reason: "core_provider" };
  }
  const slackUserId = parseSlackUserId(
    await findLinkedSlackUserId(getSqlExecutor(), {
      provider: args.provider,
      providerSubjectId: args.providerSubjectId,
      slackTeamId: args.slackTeamId,
    }),
  );
  if (!slackUserId) {
    return { status: "not_linked", reason: "no_single_link" };
  }
  const member = await lookupActiveSlackWorkspaceMember(
    slackUserId,
    args.slackTeamId,
  );
  if (!member) {
    return { status: "not_linked", reason: "inactive_member" };
  }
  if (!isSlackProfileDomainAllowed(member, args.allowedDomains)) {
    return { status: "not_linked", reason: "domain_not_allowed" };
  }
  return { status: "linked", slackUserId };
}
