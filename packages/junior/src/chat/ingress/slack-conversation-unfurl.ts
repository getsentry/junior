import type { KnownBlock } from "@slack/types";
import type { StateAdapter } from "chat";
import * as z from "zod";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import { getConversationIdByProviderConversation } from "@/chat/conversations/sql/bindings";
import type { Conversation } from "@/chat/conversations/store";
import { parseDashboardConversationLink } from "@/chat/dashboard-link";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import {
  alreadyContinuesInSlackMessage,
  canContinueInSlack,
  continueConversationInSlack,
  isMovableToSlack,
} from "@/chat/slack/continue-in-slack";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
import {
  postSlackEphemeralMessage,
  unfurlSlackLinks,
} from "@/chat/slack/outbound";
import { slackMessageTsSchema } from "@/chat/slack/timestamp";
import { checkSlackChannelReadAccess } from "@/chat/slack/tool-support/channel-access";
import { resolveSlackActingUser } from "./slack-acting-user";
import type { SlackInteractivePayload } from "./slack-payload";

/** Action id of the "Continue here" button on a dashboard link preview. */
export const SLACK_CONTINUE_HERE_ACTION_ID = "junior_continue_here";

const MAX_LINKS = 5;
const MAX_SUMMARY_CHARS = 300;

// https://docs.slack.dev/reference/events/link_shared
const linkSharedEventSchema = z.object({
  channel: z.string(),
  links: z.array(z.object({ url: z.string() })),
  message_ts: z.string(),
  source: z.string().optional(),
  thread_ts: slackMessageTsSchema.optional(),
  unfurl_id: z.string().min(1).optional(),
});

// The button value is ours: Slack sends it back as we wrote it.
const continueHereValueSchema = z.object({
  conversationId: z.string().min(1),
  messageTs: slackMessageTsSchema,
  threadTs: slackMessageTsSchema,
  url: z.string().min(1),
});

type ContinueHereValue = z.output<typeof continueHereValueSchema>;

function parseContinueHereValue(
  raw: string | undefined,
): ContinueHereValue | undefined {
  try {
    return continueHereValueSchema.parse(JSON.parse(raw ?? ""));
  } catch {
    return undefined;
  }
}

async function previewBlocks(args: {
  conversation: Conversation;
  footer?: KnownBlock;
  url: string;
}): Promise<KnownBlock[]> {
  const title = args.conversation.title ?? "Junior conversation";
  const brief = await readLatestConversationBrief(
    getDb(),
    args.conversation.conversationId,
  );
  const summary = brief?.content.summary.trim();
  const shortSummary =
    summary && summary.length > MAX_SUMMARY_CHARS
      ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`
      : summary;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${formatSlackLink(args.url, title)}*`,
          ...(shortSummary ? [escapeSlackMrkdwnText(shortSummary)] : []),
        ].join("\n"),
      },
    },
    ...(args.footer ? [args.footer] : []),
  ];
}

function continueHereButton(value: ContinueHereValue): KnownBlock {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: SLACK_CONTINUE_HERE_ACTION_ID,
        text: { type: "plain_text", text: "Continue here" },
        value: JSON.stringify(value),
      },
    ],
  };
}

async function readPublicConversation(
  conversationId: string,
): Promise<Conversation | undefined> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation || conversation.parentConversationId) return undefined;
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId])
  ).get(conversationId);
  return access?.visibility === "public" ? conversation : undefined;
}

/** Whether a thread in this channel can take a moved Conversation. */
async function canReceiveConversation(
  teamId: SlackTeamId,
  channelId: SlackChannelId,
  threadTs: string,
): Promise<boolean> {
  const bound = await getConversationIdByProviderConversation(
    getSqlExecutor(),
    {
      provider: "slack",
      providerDestinationId: channelId,
      providerTenantId: teamId,
      providerConversationId: threadTs,
    },
  );
  return !bound && (await isPublicChannel(teamId, channelId));
}

async function isPublicChannel(
  teamId: SlackTeamId,
  channelId: SlackChannelId,
): Promise<boolean> {
  const access = await checkSlackChannelReadAccess({
    currentChannelIds: [],
    targetChannelId: channelId,
    teamId,
  });
  return access.allowed && access.isPublic === true;
}

/**
 * Preview dashboard conversation links that a workspace member posted.
 *
 * Only public root Conversations get a preview, and only in channels that are
 * not shared with other organizations. A public dashboard Conversation that
 * can still move gets a "Continue here" button when the channel is public.
 */
export async function unfurlDashboardConversationLinks(args: {
  event: unknown;
  isExtSharedChannel: boolean;
  state: StateAdapter;
  teamId: string | undefined;
}): Promise<void> {
  const parsed = linkSharedEventSchema.safeParse(args.event);
  const teamId = parseSlackTeamId(args.teamId);
  // Composer previews have no real channel yet. The posted message sends
  // its own event.
  if (
    !parsed.success ||
    !teamId ||
    parsed.data.source === "composer" ||
    args.isExtSharedChannel ||
    !(await isSlackWorkspaceMember(args.event, args.state))
  ) {
    return;
  }
  const event = parsed.data;
  const channelId = parseSlackChannelId(event.channel);
  const messageTs = slackMessageTsSchema.safeParse(event.message_ts);
  if (!channelId || !messageTs.success) return;
  const threadTs = event.thread_ts ?? messageTs.data;

  const unfurls: Record<string, { blocks: KnownBlock[] }> = {};
  let canReceive: Promise<boolean> | undefined;
  const urls = [...new Set(event.links.map((link) => link.url))];
  for (const url of urls.slice(0, MAX_LINKS)) {
    const conversationId = parseDashboardConversationLink(url);
    const conversation = conversationId
      ? await readPublicConversation(conversationId)
      : undefined;
    if (!conversation) continue;
    const movable =
      isMovableToSlack(conversation) &&
      (await (canReceive ??= canReceiveConversation(
        teamId,
        channelId,
        threadTs,
      )));
    unfurls[url] = {
      blocks: await previewBlocks({
        conversation,
        url,
        ...(movable
          ? {
              footer: continueHereButton({
                conversationId: conversation.conversationId,
                messageTs: messageTs.data,
                threadTs,
                url,
              }),
            }
          : undefined),
      }),
    };
  }
  if (Object.keys(unfurls).length === 0) return;
  await unfurlSlackLinks({
    channelId,
    messageTs: messageTs.data,
    ...(event.unfurl_id ? { unfurlId: event.unfurl_id } : undefined),
    unfurls,
  });
}

/**
 * Move a dashboard Conversation into the thread of the message that shared
 * its link, as the participant who clicked "Continue here".
 */
export async function handleSlackContinueHereClick(args: {
  isAuthorAllowed: (userId: string) => Promise<boolean>;
  payload: SlackInteractivePayload;
  state: StateAdapter;
  value: string | undefined;
}): Promise<void> {
  const target = parseContinueHereValue(args.value);
  const channelId = parseSlackChannelId(args.payload.channel?.id);
  if (!target || !channelId) {
    throw new Error("Slack Continue here payload is incomplete");
  }
  const tellPerson = (userId: string, text: string) =>
    postSlackEphemeralMessage({
      channelId,
      text,
      // A top-level message has no thread to show the note in yet.
      ...(target.threadTs !== target.messageTs
        ? { threadTs: target.threadTs }
        : undefined),
      userId,
    });
  const actor = await resolveSlackActingUser({
    isAuthorAllowed: args.isAuthorAllowed,
    payload: args.payload,
    state: args.state,
    tell: tellPerson,
  });
  if (!actor) return;
  const { teamId, user } = actor;
  const tell = (text: string) => tellPerson(actor.slackUserId, text);
  const conversation = await getConversationStore().get({
    conversationId: target.conversationId,
  });
  const access = conversation
    ? (
        await readConversationAccessFromSql(
          getDb(),
          [target.conversationId],
          user,
        )
      ).get(target.conversationId)
    : undefined;
  if (!conversation || !access?.isParticipant) {
    await tell("Only people in this conversation can move it here.");
    return;
  }
  if (!canContinueInSlack(conversation, access)) {
    await tell(
      conversation.location
        ? await alreadyContinuesInSlackMessage(conversation)
        : "This conversation can no longer move to Slack.",
    );
    return;
  }
  const result = await continueConversationInSlack({
    actorName: user.displayName ?? user.email,
    channel: { channelId, teamId },
    conversation,
    threadTs: target.threadTs,
  });
  if (result.status === "refused") {
    await tell(result.message);
    return;
  }
  await unfurlSlackLinks({
    channelId,
    messageTs: target.messageTs,
    unfurls: {
      [target.url]: {
        blocks: await previewBlocks({
          conversation,
          footer: {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: result.locationUrl
                  ? `Continues in ${formatSlackLink(result.locationUrl, "this thread")}.`
                  : "Continues in this thread.",
              },
            ],
          },
          url: target.url,
        }),
      },
    },
  });
}
