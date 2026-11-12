import type { SlackAdapter } from "@chat-adapter/slack";
import type { KnownBlock } from "@slack/types";
import type { User } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import * as z from "zod";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { createSlackActor } from "@/chat/actor";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import { getConversationIdByProviderConversation } from "@/chat/conversations/sql/bindings";
import type { Conversation } from "@/chat/conversations/store";
import { parseDashboardConversationLink } from "@/chat/dashboard-link";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { withSpan } from "@/chat/logging";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import {
  alreadyContinuesInSlackMessage,
  BUSY,
  canContinueInSlack,
  continueConversationInSlack,
  isMovableToSlack,
} from "@/chat/slack/continue-in-slack";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  parseSlackUserId,
  slackChannelIdSchema,
  slackTeamIdSchema,
  slackUserIdSchema,
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
import { deferConversationMove } from "@/chat/task-execution/store";
import { resolveSlackActingUser } from "./slack-acting-user";
import type {
  SlackChannelScope,
  SlackInteractivePayload,
} from "./slack-payload";

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
  channelScope: SlackChannelScope;
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
    args.channelScope === "external" ||
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

// A click that waits for the Run of its Conversation keeps what the move
// needs to act later as the person who clicked.
const continueHereClickSchema = continueHereValueSchema.extend({
  channelId: slackChannelIdSchema,
  slackUserId: slackUserIdSchema,
  teamId: slackTeamIdSchema,
});

type ContinueHereClick = z.output<typeof continueHereClickSchema>;

function tellClicker(
  click: Pick<ContinueHereClick, "channelId" | "messageTs" | "threadTs">,
  userId: string,
  text: string,
) {
  return postSlackEphemeralMessage({
    channelId: click.channelId,
    text,
    // A top-level message has no thread to show the note in yet.
    ...(click.threadTs !== click.messageTs
      ? { threadTs: click.threadTs }
      : undefined),
    userId,
  });
}

async function showContinuesIn(
  conversation: Conversation,
  click: ContinueHereClick,
  locationUrl: string | undefined,
): Promise<void> {
  await unfurlSlackLinks({
    channelId: click.channelId,
    messageTs: click.messageTs,
    unfurls: {
      [click.url]: {
        blocks: await previewBlocks({
          conversation,
          footer: {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: locationUrl
                  ? `Continues in ${formatSlackLink(locationUrl, "this thread")}.`
                  : "Continues in this thread.",
              },
            ],
          },
          url: click.url,
        }),
      },
    },
  });
}

/**
 * Move the Conversation of a click into its thread, or store the click until
 * the Run that holds the Conversation ends. The clicker gets each refusal.
 * A stored click (`deferred`) stays quiet when it has to wait again.
 */
async function continueHere(
  click: ContinueHereClick,
  user: User,
  deferred: boolean,
): Promise<void> {
  const tell = (text: string) => tellClicker(click, click.slackUserId, text);
  // A Run can end or start between the checks. Then try again, a few times.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const conversation = await getConversationStore().get({
      conversationId: click.conversationId,
    });
    const access = conversation
      ? (
          await readConversationAccessFromSql(
            getDb(),
            [click.conversationId],
            user,
          )
        ).get(click.conversationId)
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
      channel: { channelId: click.channelId, teamId: click.teamId },
      conversation,
      threadTs: click.threadTs,
    });
    if (result.status === "refused") {
      await tell(result.message);
      return;
    }
    if (result.status === "moved") {
      await showContinuesIn(conversation, click, result.locationUrl);
      return;
    }
    const waiting = await deferConversationMove({
      conversationId: click.conversationId,
      move: click,
    });
    if (waiting.status === "idle") continue;
    if (deferred && waiting.move === click) return;
    // The first stored click wins.
    const first = continueHereClickSchema.safeParse(waiting.move).data;
    await tell(
      first?.channelId === click.channelId && first.threadTs === click.threadTs
        ? "This conversation moves here when Junior finishes."
        : "This conversation moves to another thread when Junior finishes.",
    );
    return;
  }
  await tell(BUSY);
}

/**
 * Move a dashboard Conversation into the thread of the message that shared
 * its link, as the participant who clicked "Continue here". While a Run holds
 * the Conversation, the move waits for that Run to end.
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
  const actor = await resolveSlackActingUser({
    isAuthorAllowed: args.isAuthorAllowed,
    payload: args.payload,
    state: args.state,
    tell: (userId, text) => tellClicker({ ...target, channelId }, userId, text),
  });
  if (!actor) return;
  const slackUserId = parseSlackUserId(actor.slackUserId);
  if (!slackUserId) throw new Error("Slack Continue here user is invalid");
  await continueHere(
    { ...target, channelId, slackUserId, teamId: actor.teamId },
    actor.user,
    false,
  );
}

/**
 * Run a stored "Continue here" click, as the person who clicked, after the
 * Run that held its Conversation ended. Without an adapter, Slack calls use
 * the default bot token.
 */
export async function continueDeferredSlackClick(
  value: unknown,
  getSlackAdapter: (() => SlackAdapter) | undefined,
): Promise<void> {
  const click = continueHereClickSchema.parse(value);
  const task = async () => {
    const user = (
      await readActorIdentity(
        createSlackActor(click.teamId, click.slackUserId, undefined),
      )
    )?.user;
    if (!user) throw new Error("Slack Continue here clicker is unknown");
    await continueHere(click, user, true);
  };
  await withSpan(
    "chat.slack_continue_here_deferred",
    "chat.slack_continue_here_deferred",
    { conversationId: click.conversationId },
    () =>
      getSlackAdapter
        ? runWithSlackInstallation({
            adapter: getSlackAdapter(),
            installation: { teamId: click.teamId },
            task,
          })
        : task(),
  );
}
