import { getSqlExecutor } from "@/chat/db";
import { isNativeIdentityProvider } from "@/chat/identities/identity";
import {
  findLinkedSlackUser,
  findSlackUserByPrimaryEmail,
  type LinkedSlackUser,
} from "@/chat/identities/sql";
import { isSlackProfileDomainAllowed } from "@/chat/ingress/slack-allowed-domain";
import { parseSlackUserId, type SlackUserId } from "@/chat/slack/ids";
import { lookupActiveSlackWorkspaceMember } from "@/chat/slack/users";

/** Why a person does not map to a current linked Slack member. */
export type LinkedSlackMemberMiss =
  | "core_provider"
  | "no_single_link"
  | "inactive_member"
  | "email_changed"
  | "domain_not_allowed";

/** A current Slack member and the User behind them, or why none matched. */
export type LinkedSlackMember =
  | {
      status: "linked";
      slackUserId: SlackUserId;
      user: LinkedSlackUser["user"];
    }
  | { status: "not_linked"; reason: LinkedSlackMemberMiss };

// Core owns native identities and the email-keyed `junior` web identities.
// They are not accounts from a plugin's OAuth account-linking flow, so they
// never match.
function isCoreIdentityProvider(provider: string): boolean {
  return provider === "junior" || isNativeIdentityProvider(provider);
}

/**
 * Accept one stored Slack link only when Slack ingress would accept that
 * member now: a current human member of the workspace whose Slack email is on
 * the allowed domains. With `email`, the Slack email must also still be that
 * address, so a stale stored email does not match.
 */
async function currentMember(args: {
  allowedDomains: readonly string[];
  email?: string;
  linked: LinkedSlackUser | undefined;
  slackTeamId: string;
}): Promise<LinkedSlackMember> {
  const slackUserId = parseSlackUserId(args.linked?.slackUserId);
  if (!args.linked || !slackUserId) {
    return { status: "not_linked", reason: "no_single_link" };
  }
  const member = await lookupActiveSlackWorkspaceMember(
    slackUserId,
    args.slackTeamId,
  );
  if (!member) {
    return { status: "not_linked", reason: "inactive_member" };
  }
  if (args.email && member.email?.trim().toLowerCase() !== args.email) {
    return { status: "not_linked", reason: "email_changed" };
  }
  if (!isSlackProfileDomainAllowed(member, args.allowedDomains)) {
    return { status: "not_linked", reason: "domain_not_allowed" };
  }
  return { status: "linked", slackUserId, user: args.linked.user };
}

/**
 * Find the Slack member behind one exact provider account, as Slack ingress
 * would accept them now.
 *
 * Only the provider account id that the OAuth account-linking flow stored
 * matches. Handles, emails, and display names never match. The account must
 * link to exactly one Slack user in the workspace. Slack and storage errors
 * propagate.
 */
export async function findLinkedSlackMember(args: {
  allowedDomains: readonly string[];
  provider: string;
  providerSubjectId: string;
  slackTeamId: string;
}): Promise<LinkedSlackMember> {
  if (isCoreIdentityProvider(args.provider)) {
    return { status: "not_linked", reason: "core_provider" };
  }
  return await currentMember({
    allowedDomains: args.allowedDomains,
    linked: await findLinkedSlackUser(getSqlExecutor(), {
      provider: args.provider,
      providerSubjectId: args.providerSubjectId,
      slackTeamId: args.slackTeamId,
    }),
    slackTeamId: args.slackTeamId,
  });
}

/**
 * Find the Slack member whose User has this primary email, as Slack ingress
 * would accept them now. The caller must have verified that the person sent
 * from this address. Slack and storage errors propagate.
 */
export async function findSlackMemberByVerifiedEmail(args: {
  allowedDomains: readonly string[];
  /** Lowercase address. */
  email: string;
  slackTeamId: string;
}): Promise<LinkedSlackMember> {
  return await currentMember({
    allowedDomains: args.allowedDomains,
    email: args.email,
    linked: await findSlackUserByPrimaryEmail(getSqlExecutor(), {
      normalizedEmail: args.email,
      slackTeamId: args.slackTeamId,
    }),
    slackTeamId: args.slackTeamId,
  });
}
