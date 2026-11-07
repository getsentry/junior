import type { User } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { readLatestConversationBrief } from "@/chat/briefs/store";
import type { Conversation } from "@/chat/conversations/store";
import { bindProviderConversation } from "@/chat/conversations/sql/bindings";
import { setFirstConversationLocation } from "@/chat/conversations/sql/location";
import { withConversationMutationLock } from "@/chat/conversations/sql/store";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import {
  parseSlackChannelId,
  parseSlackTeamId,
  type SlackChannelId,
  type SlackTeamId,
} from "@/chat/slack/ids";
import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
import { deleteSlackMessage, postSlackMessage } from "@/chat/slack/outbound";
import {
  checkSlackChannelReadAccess,
  joinPublicChannelForRead,
} from "@/chat/slack/tool-support/channel-access";
import { getStateAdapter } from "@/chat/state/adapter";
import { moveIdleConversationDestination } from "@/chat/task-execution/store";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import { juniorDestinations } from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ContinueConversationInSlackBody,
  ContinueConversationInSlackResponse,
} from "../schema/conversation-continue-in-slack";
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";

const BUSY_ERROR = "Wait for Junior to finish, then try again.";

interface SlackChannelLocation {
  channelId: SlackChannelId;
  channelName?: string;
  id: string;
  teamId: SlackTeamId;
}

/**
 * Return whether a viewer can move this Conversation to a Slack thread.
 *
 * Only a public dashboard root with no Location qualifies. The move is
 * one-way, so a Conversation that has a Location never qualifies again.
 */
export function canContinueInSlack(
  conversation: Pick<
    Conversation,
    "conversationId" | "location" | "parentConversationId"
  >,
  access: ConversationAccess | undefined,
): boolean {
  return (
    access?.isParticipant === true &&
    access.visibility === "public" &&
    conversation.conversationId.startsWith("local:web:") &&
    !conversation.location &&
    !conversation.parentConversationId
  );
}

async function readSlackChannelLocation(
  locationId: string,
): Promise<SlackChannelLocation | undefined> {
  const [row] = await getDb()
    .select({
      channelId: juniorDestinations.providerDestinationId,
      displayName: juniorDestinations.displayName,
      id: juniorDestinations.id,
      teamId: juniorDestinations.providerTenantId,
    })
    .from(juniorDestinations)
    .where(
      and(
        eq(juniorDestinations.id, locationId),
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.kind, "channel"),
      ),
    );
  const channelId = parseSlackChannelId(row?.channelId);
  const teamId = parseSlackTeamId(row?.teamId);
  if (!row || !channelId || !teamId) return undefined;
  return {
    channelId,
    ...(row.displayName ? { channelName: row.displayName } : undefined),
    id: row.id,
    teamId,
  };
}

/** Build the thread root: what the Conversation is and where it came from. */
async function threadRootText(
  conversation: Conversation,
  viewer: User,
): Promise<string> {
  const title = conversation.title ?? "Junior conversation";
  const url = getDashboardConversationLink(conversation.conversationId);
  const brief = await readLatestConversationBrief(
    getDb(),
    conversation.conversationId,
  );
  const name = viewer.displayName ?? viewer.email;
  return [
    `*${url ? formatSlackLink(url, title) : escapeSlackMrkdwnText(title)}*`,
    ...(brief ? [`> ${escapeSlackMrkdwnText(brief.content.summary)}`] : []),
    `${escapeSlackMrkdwnText(name)} moved this conversation here from the dashboard. Mention me in this thread to continue.`,
  ].join("\n");
}

/** Make sure Junior can post in a public channel, then start the thread. */
async function postThreadRoot(
  channel: SlackChannelLocation,
  text: string,
): Promise<{ channelName?: string; permalink?: string; ts: SlackMessageTs }> {
  const access = await checkSlackChannelReadAccess({
    currentChannelIds: [],
    targetChannelId: channel.channelId,
    teamId: channel.teamId,
  });
  if (!access.allowed) {
    throwApiError(
      409,
      access.reason === "private"
        ? "Only a public channel can be chosen."
        : access.error,
    );
  }
  const channelName = access.channelName ?? channel.channelName;
  if (access.isMember !== true) {
    const joined = await joinPublicChannelForRead({
      targetChannelId: channel.channelId,
      ...(channelName ? { channelName } : undefined),
    });
    if (!joined.ok) throwApiError(409, joined.error);
  }
  const posted = await postSlackMessage({
    channelId: channel.channelId,
    includePermalink: true,
    text,
  });
  return {
    ...(channelName ? { channelName } : undefined),
    ...(posted.permalink ? { permalink: posted.permalink } : undefined),
    ts: posted.ts,
  };
}

/**
 * Move a public dashboard Conversation to a new thread in a public Slack
 * channel.
 *
 * Junior posts the thread root first, then stores the thread as the
 * Conversation Location and binds it. Replies in that thread then reach this
 * Conversation. Dashboard Messages still get no Slack Delivery.
 */
export async function continueConversationInSlackForViewer(
  viewer: User,
  conversationId: string,
  body: ContinueConversationInSlackBody,
): Promise<ContinueConversationInSlackResponse> {
  const conversationStore = getConversationStore();
  const conversation = await conversationStore.get({ conversationId });
  const access = conversation
    ? (
        await readConversationAccessFromSql(getDb(), [conversationId], viewer)
      ).get(conversationId)
    : undefined;
  if (!conversation || !access?.canViewPrivateContent) {
    throwApiError(404, "Conversation not found.");
  }
  if (!access.isParticipant) {
    throwApiError(403, "Only conversation participants can move it to Slack.");
  }
  if (!canContinueInSlack(conversation, access)) {
    throwApiError(
      409,
      "Only a public dashboard conversation can move to Slack, once.",
    );
  }
  // A Run keeps its own copy of the dashboard Destination and writes it back
  // when it finishes. Check before posting; the move checks again.
  if (
    conversation.execution.status === "running" ||
    conversation.execution.status === "paused"
  ) {
    throwApiError(409, BUSY_ERROR);
  }
  const channel = await readSlackChannelLocation(body.locationId);
  if (!channel) throwApiError(404, "Channel not found.");

  const adapter = getProductionSlackAdapter();
  const installation = { teamId: channel.teamId };
  const text = await threadRootText(conversation, viewer);
  const root = await runWithSlackInstallation({
    adapter,
    installation,
    task: () => postThreadRoot(channel, text),
  });
  const destination = {
    platform: "slack" as const,
    teamId: channel.teamId,
    channelId: channel.channelId,
  };
  // The live channel check above proved that the channel is public.
  await conversationStore.recordDestinationVisibility({
    destination,
    ...(root.channelName ? { channelName: root.channelName } : undefined),
    visibility: "public",
  });

  const executor = getSqlExecutor();
  const moved = await moveIdleConversationDestination({
    conversationId,
    destination,
    move: () =>
      withConversationMutationLock(executor, conversationId, async () => {
        const stored = await setFirstConversationLocation(executor, {
          ...(root.channelName ? { channelName: root.channelName } : undefined),
          conversationId,
          location: {
            id: channel.id,
            provider: "slack",
            teamId: channel.teamId,
            channelId: channel.channelId,
            threadTs: root.ts,
          },
        });
        if (!stored) return false;
        await bindProviderConversation(executor, {
          conversationId,
          provider: "slack",
          providerDestinationId: channel.channelId,
          providerTenantId: channel.teamId,
          providerConversationId: root.ts,
        });
        return true;
      }),
  });
  if (moved !== "moved") {
    // A Run started, or another request moved it first. Remove the root.
    await runWithSlackInstallation({
      adapter,
      installation,
      task: () =>
        deleteSlackMessage({
          channelId: channel.channelId,
          timestamp: root.ts,
        }),
    });
    throwApiError(
      409,
      moved === "busy"
        ? BUSY_ERROR
        : "This conversation already continues in Slack.",
    );
  }
  // Thread replies without a mention join the Conversation history.
  await getStateAdapter().subscribe(`slack:${channel.channelId}:${root.ts}`);
  return {
    conversationId,
    ...(root.channelName ? { channelName: root.channelName } : undefined),
    ...(root.permalink ? { locationUrl: root.permalink } : undefined),
  };
}
