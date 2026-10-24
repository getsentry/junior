/** Require dashboard sign-in before a Slack user can start a Turn. */
import { SLACK_SIGN_IN_PATH } from "@/api/slack-sign-in";
import { botConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { getDashboardRouteLink } from "@/chat/dashboard-link";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import type { SlackInboundEvent } from "@/chat/ingress/slack-payload";
import { isSlackIdentitySignedIn, upsertIdentity } from "@/chat/identities/sql";
import type { SlackInstallationContext } from "@/chat/slack/adapter-context";
import { getSlackClient, withSlackRetries } from "@/chat/slack/client";
import { parseSlackUserId } from "@/chat/slack/ids";
import { formatSlackLink } from "@/chat/slack/mrkdwn";
import { lookupSlackUserProfile } from "@/chat/slack/users";

/**
 * Return whether this Slack user may start work.
 *
 * When the user has not signed in, save the Slack identity with the email from
 * the Slack profile, so the sign-in page can match it. Then send the user a
 * private sign-in link and drop the message.
 */
export async function hasSlackSignIn(args: {
  event: SlackInboundEvent;
  installation: SlackInstallationContext;
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

  const link = getDashboardRouteLink(SLACK_SIGN_IN_PATH);
  if (!link) {
    throw new Error("Slack sign-in requires the Junior dashboard");
  }
  const client = getSlackClient();
  await withSlackRetries(
    () =>
      client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `${formatSlackLink(link, `Sign in to use ${botConfig.userName}`)}. Sign in once with your work account, then send your message again.`,
        ...(args.event.thread_ts
          ? { thread_ts: args.event.thread_ts }
          : undefined),
      }),
    3,
    { action: "chat.postEphemeral" },
  );
  return false;
}
