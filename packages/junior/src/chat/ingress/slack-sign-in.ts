/** Require a recent Google sign-in before a Slack user can start a Turn. */
import { botConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import type { SlackInboundEvent } from "@/chat/ingress/slack-payload";
import {
  slackUserHasGoogleSignIn,
  upsertIdentity,
} from "@/chat/identities/sql";
import type { SlackInstallationContext } from "@/chat/slack/adapter-context";
import { parseSlackUserId } from "@/chat/slack/ids";
import { formatSlackLink } from "@/chat/slack/mrkdwn";
import { lookupSlackUserProfile } from "@/chat/slack/users";
import { deliverPrivateMessage } from "@/chat/oauth-flow";
import { createSlackSignInUrl, type SlackSignIn } from "@/chat/sign-in/slack";
import type { StateAdapter } from "chat";

/**
 * Return whether this Slack user may start work.
 *
 * The user of the Slack identity must have signed in with Google, in Slack or
 * in the dashboard, within `signIn.maxAgeMs`. When it has not, save the Slack
 * identity with the email from the Slack profile, so the sign-in page can match
 * it, and check again. Then send the user a private sign-in link and drop the
 * message.
 */
export async function hasSlackSignIn(args: {
  event: SlackInboundEvent;
  installation: SlackInstallationContext;
  signIn: SlackSignIn | undefined;
  state: StateAdapter;
}): Promise<boolean> {
  if (!args.signIn) return true;
  const teamId = args.installation.teamId;
  const channelId = args.event.channel;
  const userId = parseSlackUserId(args.event.user);
  if (!teamId || !channelId || !userId) return false;
  const executor = getSqlExecutor();
  const signedInSince = new Date(Date.now() - args.signIn.maxAgeMs);
  const hasSignIn = () =>
    slackUserHasGoogleSignIn(executor, {
      signedInSince,
      slackTeamId: teamId,
      slackUserId: userId,
    });
  if (await hasSignIn()) return true;

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
  // The first Slack message links the Slack identity to its user. That user
  // may already have a recent dashboard sign-in.
  if (await hasSignIn()) return true;

  const link = await createSlackSignInUrl({
    baseURL: args.signIn.baseURL,
    slackTeamId: teamId,
    slackUserId: userId,
    state: args.state,
  });
  await deliverPrivateMessage({
    channelId,
    ...(args.event.thread_ts ? { threadTs: args.event.thread_ts } : undefined),
    userId,
    text: `${formatSlackLink(link, `Sign in to use ${botConfig.userName}`)}. Sign in with your work Google account, then send your message again.`,
  });
  return false;
}
