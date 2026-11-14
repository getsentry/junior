import { and, eq } from "drizzle-orm";
import type { ConversationAccess } from "@/api/conversations/access";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import type { Conversation } from "@/chat/conversations/store";
import {
  claimProviderConversation,
  getConversationIdByProviderConversation,
} from "@/chat/conversations/sql/bindings";
import { setFirstConversationLocation } from "@/chat/conversations/sql/location";
import { withConversationMutationLock } from "@/chat/conversations/sql/store";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import {
  parseSlackChannelId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
import {
  deleteSlackMessage,
  getSlackMessagePermalink,
  postSlackMessage,
} from "@/chat/slack/outbound";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import {
  checkSlackChannelReadAccess,
  joinPublicChannelForRead,
} from "@/chat/slack/tool-support/channel-access";
import { getStateAdapter } from "@/chat/state/adapter";
import { moveIdleConversationDestination } from "@/chat/task-execution/store";
import { juniorDestinations } from "@/db/schema";

/** Refusal for a move that cannot wait for the active Run. */
export const BUSY = "Wait for Junior to finish, then try again.";
const THREAD_TAKEN = "This thread already has a Junior conversation.";
// Thrown in the move transaction to roll back the thread claim.
const MOVED_ELSEWHERE = new Error("Conversation already has a Location");

/** The Slack channel that a dashboard Conversation moves to. */
export interface ContinueInSlackChannel {
  channelId: SlackChannelId;
  channelName?: string;
  teamId: SlackTeamId;
}

export type ContinueInSlackResult =
  | {
      channelName?: string;
      locationUrl?: string;
      status: "moved";
    }
  | { message: string; status: "refused" }
  // A Run holds the Conversation. Nothing was posted.
  | { status: "busy" };

/**
 * Return whether a Conversation can still move to a Slack thread.
 *
 * Only a dashboard root with no Location qualifies. The move is one-way, so
 * a Conversation that has a Location never qualifies again.
 */
export function isMovableToSlack(
  conversation: Pick<
    Conversation,
    "conversationId" | "location" | "parentConversationId"
  >,
): boolean {
  return (
    conversation.conversationId.startsWith("local:web:") &&
    !conversation.location &&
    !conversation.parentConversationId
  );
}

/** Return whether a viewer can move this public Conversation to Slack. */
export function canContinueInSlack(
  conversation: Pick<
    Conversation,
    "conversationId" | "location" | "parentConversationId"
  >,
  access: Pick<ConversationAccess, "isParticipant" | "visibility"> | undefined,
): boolean {
  return (
    access?.isParticipant === true &&
    access.visibility === "public" &&
    isMovableToSlack(conversation)
  );
}

/** Text for the first message of the Conversation in Slack. */
async function movedMessageText(
  conversation: Conversation,
  actorName: string,
): Promise<string> {
  const title = conversation.title ?? "Junior conversation";
  const url = getDashboardConversationLink(conversation.conversationId);
  const brief = await readLatestConversationBrief(
    getDb(),
    conversation.conversationId,
  );
  return [
    `*${url ? formatSlackLink(url, title) : escapeSlackMrkdwnText(title)}*`,
    ...(brief ? [`> ${escapeSlackMrkdwnText(brief.content.summary)}`] : []),
    `${escapeSlackMrkdwnText(actorName)} moved this conversation here from the dashboard. Mention me in this thread to continue.`,
  ].join("\n");
}

/** Make sure Junior can post in a public channel, then post there. */
async function postMovedMessage(
  channel: ContinueInSlackChannel,
  text: string,
  threadTs: SlackMessageTs | undefined,
): Promise<
  | { channelName?: string; permalink?: string; ts: SlackMessageTs }
  | { refused: string }
> {
  const access = await checkSlackChannelReadAccess({
    currentChannelIds: [],
    targetChannelId: channel.channelId,
    teamId: channel.teamId,
  });
  if (!access.allowed) {
    return {
      refused:
        access.reason === "private"
          ? "Only a public channel can be chosen."
          : access.error,
    };
  }
  const channelName = access.channelName ?? channel.channelName;
  if (access.isMember !== true) {
    const joined = await joinPublicChannelForRead({
      targetChannelId: channel.channelId,
      ...(channelName ? { channelName } : undefined),
    });
    if (!joined.ok) return { refused: joined.error };
  }
  const posted = await postSlackMessage({
    channelId: channel.channelId,
    includePermalink: true,
    text,
    ...(threadTs ? { threadTs } : undefined),
  });
  return {
    ...(channelName ? { channelName } : undefined),
    ...(posted.permalink ? { permalink: posted.permalink } : undefined),
    ts: posted.ts,
  };
}

/** Read the id of the Location row of one Slack channel. */
export async function readChannelLocationId(
  channel: ContinueInSlackChannel,
): Promise<string> {
  const [row] = await getDb()
    .select({ id: juniorDestinations.id })
    .from(juniorDestinations)
    .where(
      and(
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.providerTenantId, channel.teamId),
        eq(juniorDestinations.providerDestinationId, channel.channelId),
      ),
    );
  if (!row) throw new Error("Slack channel Location was not stored");
  return row.id;
}

/** Say which Slack thread a Conversation that already moved continues in. */
export async function alreadyContinuesInSlackMessage(
  conversation: Pick<Conversation, "channelName" | "location">,
): Promise<string> {
  const { location } = conversation;
  const channelId =
    location?.provider === "slack"
      ? parseSlackChannelId(location.channelId)
      : undefined;
  const threadTs = parseSlackMessageTs(
    location?.provider === "slack" ? location.threadTs : undefined,
  );
  const url =
    channelId && threadTs
      ? await getSlackMessagePermalink({ channelId, messageTs: threadTs })
      : undefined;
  const place = conversation.channelName
    ? `#${conversation.channelName}`
    : "Slack";
  return url
    ? `This conversation already continues in ${place}: ${url}`
    : `This conversation already continues in ${place}.`;
}

/**
 * Move a qualifying dashboard Conversation to a public Slack channel thread.
 *
 * With `threadTs`, Junior replies in that existing thread. Without it, Junior
 * starts a new thread. The thread then becomes the Conversation Location and
 * its replies reach this Conversation. Dashboard Messages still get no Slack
 * Delivery. The caller checks who may move it, and runs this inside the
 * Slack installation of `channel.teamId`.
 */
export async function continueConversationInSlack(args: {
  actorName: string;
  channel: ContinueInSlackChannel;
  conversation: Conversation;
  threadTs?: SlackMessageTs;
}): Promise<ContinueInSlackResult> {
  const { channel, conversation } = args;
  const conversationId = conversation.conversationId;
  // A Run keeps its own copy of the dashboard Destination and writes it back
  // when it finishes. Check before posting; the move checks again.
  if (
    conversation.execution.status === "running" ||
    conversation.execution.status === "paused"
  ) {
    return { status: "busy" };
  }
  const executor = getSqlExecutor();
  const binding = (threadTs: string) => ({
    provider: "slack",
    providerDestinationId: channel.channelId,
    providerTenantId: channel.teamId,
    providerConversationId: threadTs,
  });
  if (
    args.threadTs &&
    (await getConversationIdByProviderConversation(
      executor,
      binding(args.threadTs),
    ))
  ) {
    return { message: THREAD_TAKEN, status: "refused" };
  }

  const posted = await postMovedMessage(
    channel,
    await movedMessageText(conversation, args.actorName),
    args.threadTs,
  );
  if ("refused" in posted) {
    return { message: posted.refused, status: "refused" };
  }
  const threadTs = args.threadTs ?? posted.ts;
  const destination = {
    platform: "slack" as const,
    teamId: channel.teamId,
    channelId: channel.channelId,
  };
  // The live channel check above proved that the channel is public.
  await getConversationStore().recordDestinationVisibility({
    destination,
    ...(posted.channelName ? { channelName: posted.channelName } : undefined),
    visibility: "public",
  });
  const locationId = await readChannelLocationId(channel);

  let threadTaken = false;
  const moved = await moveIdleConversationDestination({
    conversationId,
    destination,
    move: async () => {
      try {
        return await withConversationMutationLock(
          executor,
          conversationId,
          async () => {
            // Claim the thread first. Moves of other Conversations to the
            // same thread hold other locks, so only the unique binding
            // decides which one wins.
            if (
              !(await claimProviderConversation(executor, {
                conversationId,
                ...binding(threadTs),
              }))
            ) {
              threadTaken = true;
              return false;
            }
            const stored = await setFirstConversationLocation(executor, {
              ...(posted.channelName
                ? { channelName: posted.channelName }
                : undefined),
              conversationId,
              location: {
                id: locationId,
                provider: "slack",
                teamId: channel.teamId,
                channelId: channel.channelId,
                threadTs,
              },
            });
            // Roll back the claim: this Conversation moved somewhere else.
            if (!stored) throw MOVED_ELSEWHERE;
            return true;
          },
        );
      } catch (error) {
        if (error === MOVED_ELSEWHERE) return false;
        throw error;
      }
    },
  });
  if (moved !== "moved") {
    // A Run started, or another move won the race. Remove the extra post.
    await deleteSlackMessage({
      channelId: channel.channelId,
      timestamp: posted.ts,
    });
    if (moved === "busy") return { status: "busy" };
    const current = await getConversationStore().get({ conversationId });
    return {
      message: threadTaken
        ? THREAD_TAKEN
        : await alreadyContinuesInSlackMessage(current ?? conversation),
      status: "refused",
    };
  }
  // Thread replies without a mention join the Conversation history.
  await getStateAdapter().subscribe(`slack:${channel.channelId}:${threadTs}`);
  return {
    ...(posted.channelName ? { channelName: posted.channelName } : undefined),
    ...(posted.permalink ? { locationUrl: posted.permalink } : undefined),
    status: "moved",
  };
}
