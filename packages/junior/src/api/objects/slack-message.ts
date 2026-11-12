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
  type SlackConversationInfo,
} from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import { parseSlackTeamId, type SlackTeamId } from "@/chat/slack/ids";
import { resolveSlackTeamDomain } from "@/chat/slack/team-domain";
import {
  parseSlackMessageReference,
  type SlackMessageReference,
} from "@/chat/slack/tool-support/slack-message-url";
import { lookupSlackUserNames } from "@/chat/slack/user";
import { messageObjectCard } from "./cards";

/** Slack permalinks, such as `acme.slack.com/archives/C123/p1712345000000100`. */
export const SLACK_MESSAGE_LINK_FILTER: ObjectLinkFilter = {
  host: "*.slack.com",
  pathPattern: "/archives/*/*",
};

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Errors that mean the bot cannot see the channel or the message. The card
// then shows nothing, the same as for a link to no message.
const HIDDEN_ERRORS = new Set(["not_found", "not_in_channel", "missing_scope"]);

function isHiddenError(error: unknown): boolean {
  return error instanceof SlackActionError && HIDDEN_ERRORS.has(error.code);
}

function isPublicChannel(info: SlackConversationInfo): boolean {
  return info.isChannel && !info.isPrivate && !info.isIm && !info.isMpim;
}

function channelLabel(info: SlackConversationInfo): string {
  if (info.isIm) return "Direct message";
  if (info.isMpim) return "Group message";
  return info.name ? `#${info.name}` : "Slack channel";
}

/** Slack mrkdwn as plain text, with names for user mentions. */
function plainText(text: string, names: ReadonlyMap<string, string>): string {
  return text
    .replace(USER_MENTION, (_, id: string) => `@${names.get(id) ?? "someone"}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
  // A public channel is public to the workspace. Any other channel, DM, or
  // group DM resolves only for its members.
  if (
    !isPublicChannel(info) &&
    !(await isConversationMember(channelId, args.slackUserId))
  ) {
    return undefined;
  }

  let message: Awaited<ReturnType<typeof getChannelMessage>>;
  try {
    message = await getChannelMessage({ channelId, messageTs, threadTs });
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
  const mentions = [...(message?.text ?? "").matchAll(USER_MENTION)].map(
    (match) => match[1]!,
  );
  const userIds = [
    ...new Set([...(message?.user ? [message.user] : []), ...mentions]),
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
    ...(message?.text ? { text: plainText(message.text, names) } : undefined),
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
