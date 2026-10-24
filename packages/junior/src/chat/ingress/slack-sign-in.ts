/** Require Google sign-in before a Slack user can start a Turn. */
import { botConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import type { SlackInboundEvent } from "@/chat/ingress/slack-payload";
import { isSlackIdentitySignedIn, upsertIdentity } from "@/chat/identities/sql";
import type { SlackInstallationContext } from "@/chat/slack/adapter-context";
import { parseSlackUserId } from "@/chat/slack/ids";
import { formatSlackLink } from "@/chat/slack/mrkdwn";
import { lookupSlackUserProfile } from "@/chat/slack/users";
import { deliverPrivateMessage } from "@/chat/oauth-flow";
import { createSlackSignInUrl } from "@/chat/sign-in";
import type { StateAdapter } from "chat";

/**
 * Return whether this Slack user may start work.
 *
 * When the user has not signed in, save the Slack identity with the email from
 * the Slack profile, so the sign-in callback can match it. Then send the user a
 * private sign-in link and drop the message.
 */
export async function hasSlackSignIn(args: {
  event: SlackInboundEvent;
  installation: SlackInstallationContext;
  state: StateAdapter;
}): Promise<boolean> {
  if (!isExperimentalFeatureEnabled("slack-sign-in")) return true;
  const teamId = args.installation.teamId;
  const channelId = args.event.channel;
  const userId = parseSlackUserId(args.event.user);
  if (!teamId || !channelId || !userId) return false;
  const executor = getSqlExecutor();
  if (await isSlackIdentitySignedIn(executor, teamId, userId)) {
    return true;
  }

  const profile = await lookupSlackUserProfile(userId);
  await upsertIdentity(executor, {
    kind: "user",
    provider: "slack",
    providerTenantId: teamId,
    providerSubjectId: userId,
    ...(profile.real_name ? { displayName: profile.real_name } : undefined),
    ...(profile.name ? { handle: profile.name } : undefined),
    ...(profile.email
      ? { email: profile.email, emailVerified: true }
      : undefined),
    metadata: { platform: "slack" },
  });

  const link = await createSlackSignInUrl({
    slackTeamId: teamId,
    slackUserId: userId,
    state: args.state,
  });
  await deliverPrivateMessage({
    channelId,
    ...(args.event.thread_ts ? { threadTs: args.event.thread_ts } : undefined),
    userId,
    text: `${formatSlackLink(link, `Sign in to use ${botConfig.userName}`)}. Sign in once with your work Google account, then send your message again.`,
  });
  return false;
}
