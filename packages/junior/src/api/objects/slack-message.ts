/**
 * Slack message permalinks as cards. Junior has no Slack token of the
 * viewer, so the bot reads the message, and the card shows only what the
 * viewer's own linked Slack account can see in that workspace.
 */
import type {
  ObjectAnnotation,
  ObjectLinkFilter,
  User,
} from "@sentry/junior-plugin-api";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { logWarn } from "@/chat/logging";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import {
  getChannelMessage,
  getConversationInfo,
  isConversationMember,
  isPublicSlackChannel,
  type SlackConversationInfo,
} from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import { parseSlackTeamId, type SlackTeamId } from "@/chat/slack/ids";
import { renderSlackPlainText } from "@/chat/slack/message/content";
import { slackMentionedUserIds } from "@/chat/slack/mrkdwn";
import { resolveSlackTeamDomain } from "@/chat/slack/team-domain";
import {
  parseSlackMessageReference,
  type SlackMessageReference,
} from "@/chat/slack/tool-support/slack-message-url";
import { lookupSlackUser, lookupSlackUserNames } from "@/chat/slack/user";
import { messageObjectCard } from "./cards";

/** Slack permalinks, such as `acme.slack.com/archives/C123/p1712345000000100`. */
export const SLACK_MESSAGE_LINK_FILTER: ObjectLinkFilter = {
  host: "*.slack.com",
  pathPattern: "/archives/*/*",
};

// Errors that mean the bot cannot see the channel or the message. The card
// then shows nothing, the same as for a link to no message.
const HIDDEN_ERRORS = new Set(["not_found", "not_in_channel", "missing_scope"]);

function isHiddenError(error: unknown): boolean {
  return error instanceof SlackActionError && HIDDEN_ERRORS.has(error.code);
}

function channelLabel(info: SlackConversationInfo): string {
  if (info.isIm) return "Direct message";
  if (info.isMpim) return "Group message";
  return info.name ? `#${info.name}` : "Slack channel";
}

/** Read the card for one viewer, inside the installation of their team. */
async function readMessageCard(args: {
  reference: SlackMessageReference;
  slackUserId: string;
  teamId: SlackTeamId;
  url: URL;
}): Promise<ObjectAnnotation | undefined> {
  const { channelId, messageTs, threadTs } = args.reference;
  let info: SlackConversationInfo;
  try {
    info = await getConversationInfo(channelId);
  } catch (error) {
    if (isHiddenError(error)) return undefined;
    throw error;
  }
  // A public channel is open to full workspace members. A guest sees only
  // the channels they are in, so a guest, a person Slack does not describe,
  // and any other channel, DM, or group DM need membership.
  const openToViewer =
    isPublicSlackChannel(info) &&
    (await lookupSlackUser(args.teamId, args.slackUserId))?.isGuest === false;
  if (
    !openToViewer &&
    !(await isConversationMember(channelId, args.slackUserId))
  ) {
    return undefined;
  }

  let message: Awaited<ReturnType<typeof getChannelMessage>>;
  try {
    message = await getChannelMessage({ channelId, messageTs, threadTs });
    // A deleted reply, or a timestamp not in the thread, has no card.
    if (!message) return undefined;
  } catch (error) {
    // A deleted message has no card.
    if (
      error instanceof SlackActionError &&
      error.apiError === "thread_not_found"
    ) {
      return undefined;
    }
    // The bot reads a public channel only after it joins it. Keep the card
    // without the message, and do not join a channel for a card.
    if (!isHiddenError(error)) throw error;
  }
  const userIds = [
    ...new Set([
      ...(message?.user ? [message.user] : []),
      ...slackMentionedUserIds(message?.text ?? ""),
    ]),
  ];
  const names = new Map(
    [...(await lookupSlackUserNames(args.teamId, userIds))].flatMap(
      ([id, name]) => {
        const label = name.fullName ?? name.userName;
        return label ? [[id, label] as const] : [];
      },
    ),
  );
  const author =
    (message?.user ? names.get(message.user) : undefined) ??
    message?.bot_profile?.name;
  return messageObjectCard({
    ...(author ? { author } : undefined),
    channel: channelLabel(info),
    key: `slack:${args.teamId}:${channelId}:${messageTs}`,
    sentAt: new Date(Number(messageTs) * 1000).toISOString(),
    ...(message?.text
      ? { text: renderSlackPlainText(message.text, names) }
      : undefined),
    url: args.url.href,
  });
}

/**
 * Resolve a Slack message permalink for the viewer. The link's workspace
 * must be one where the viewer linked a Slack account. Without that
 * account, or without access to the channel, the link gets no card.
 */
export async function resolveSlackMessageLink(
  viewer: User,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const parsed = parseSlackMessageReference(url.href);
  if (!parsed.ok) return undefined;
  for (const identity of viewer.identities) {
    const teamId = parseSlackTeamId(identity.providerTenantId);
    if (identity.provider !== "slack" || !teamId) continue;
    const run = <T>(task: () => Promise<T>) =>
      runWithSlackInstallation({
        adapter: getProductionSlackAdapter(),
        installation: { teamId },
        task,
      });
    let domain: string | undefined;
    try {
      domain = await run(() => resolveSlackTeamDomain(teamId));
    } catch (error) {
      // A workspace that removed Junior has no token. Check the next one.
      logWarn("object_link.slack_team.unavailable", {
        "app.slack.team_id": teamId,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!domain || url.hostname !== `${domain}.slack.com`) continue;
    return await run(() =>
      readMessageCard({
        reference: parsed.reference,
        slackUserId: identity.providerSubjectId,
        teamId,
        url,
      }),
    );
  }
  return undefined;
}
