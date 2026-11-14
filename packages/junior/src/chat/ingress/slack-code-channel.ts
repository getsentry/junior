/**
 * Route Slack events in a code channel that a channel Thread owns. The
 * channel binding decides, not a Slack thread binding or a feature flag, so
 * a bound channel keeps working after the `code-channels` flag turns off.
 * https://docs.slack.dev/ai/slack-code/lifecycle
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import { createSlackDestination } from "@/chat/destination";
import { createSlackActor, parseActorUserId } from "@/chat/actor";
import { archiveChannelThread } from "@/chat/agent-invocations/channel-thread-wrap-up";
import { botConfig } from "@/chat/config";
import { getConversationIdByWholeDestination } from "@/chat/conversations/sql/bindings";
import { stopConversation } from "@/chat/conversations/stop";
import { getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { isSlackAuthorDomainAllowed } from "@/chat/ingress/slack-allowed-domain";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { stripLeadingBotMention } from "@/chat/runtime/thread-context";
import { getThreadStopDecision } from "@/chat/services/subscribed-decision";
import type { SlackInstallationContext } from "@/chat/slack/adapter-context";
import { codeChannelMessageMetadata } from "@/chat/slack/code-channel/input";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { slackInboundMessageId } from "@/chat/task-execution/slack-work";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { shouldIgnoreMessageSubtype } from "./slack-message-subtypes";
import type { SlackInboundEvent } from "./slack-payload";

function slackTsMs(ts: string): number {
  return Math.floor(Number(ts) * 1_000);
}

/**
 * Handle one Slack event in a code channel bound to a channel Thread, and
 * return true. Return false when no channel Thread owns the channel, so the
 * caller routes the event as usual. An unbound code channel, such as one a
 * person opened from Slack, runs normal root Turns.
 *
 * A stop has no ack and no session status call: Slack shows the stop itself,
 * and its lifecycle doc forbids a post or an `agents.*` call after it.
 */
export async function routeSlackCodeChannelEvent(args: {
  adapter: SlackAdapter;
  allowedBotUserIds: readonly string[];
  allowedDomains: readonly string[];
  event: SlackInboundEvent;
  installation: SlackInstallationContext;
  queue: ConversationWorkQueue;
  receivedAtMs: number;
  state: StateAdapter;
}): Promise<boolean> {
  const { event, installation } = args;
  const channelId = event.channel;
  const teamId = installation.teamId;
  if (!channelId || !teamId) return false;
  const conversationId = await getConversationIdByWholeDestination(
    getSqlExecutor(),
    {
      provider: "slack",
      providerTenantId: teamId,
      providerDestinationId: channelId,
    },
  );
  if (!conversationId) return false;

  if (event.type === "agent_session_stopped") {
    if (!(await isSlackWorkspaceMember(event, args.state))) return true;
    // With or without `thread_ts`, the whole channel is one session.
    await stopConversation({
      conversationId,
      ...(event.event_ts
        ? {
            message: {
              conversationId,
              createdAtMs: slackTsMs(event.event_ts),
              destination: createSlackDestination({ channelId, teamId }),
              inboundMessageId: slackInboundMessageId({
                conversationId,
                installation,
                slackId: `agent_session_stopped:${event.event_ts}`,
              }),
              source: "slack" as const,
            },
          }
        : undefined),
      queue: args.queue,
      state: args.state,
    });
    return true;
  }
  if (event.type !== "message" || !event.ts) {
    // Slack sends a mention as both `message` and `app_mention`. The
    // `message` event carries every post here, mention or not.
    return true;
  }
  if (event.subtype === "channel_archive") {
    await archiveChannelThread({
      conversationId,
      eventKey: event.ts,
      queue: args.queue,
      state: args.state,
    });
    return true;
  }
  const userId = parseActorUserId(event.user);
  if (
    shouldIgnoreMessageSubtype(event) ||
    !userId ||
    event.bot_id !== undefined ||
    userId === args.adapter.botUserId
  ) {
    return true;
  }
  if (!(await isSlackWorkspaceMember(event, args.state))) return true;

  const inboundMessageId = slackInboundMessageId({
    conversationId,
    installation,
    slackId: event.ts,
  });
  const createdAtMs = slackTsMs(event.ts);
  const destination = createSlackDestination({ channelId, teamId });
  const rawText = event.text ?? "";
  if (
    getThreadStopDecision({
      botUserName: botConfig.userName,
      isExplicitMention: false,
      rawText,
      text: rawText,
    })
  ) {
    await stopConversation({
      conversationId,
      message: {
        conversationId,
        createdAtMs,
        destination,
        inboundMessageId,
        source: "slack",
      },
      queue: args.queue,
      state: args.state,
    });
    return true;
  }
  // Every post here is for Junior, so each one gets the domain check that a
  // mention gets elsewhere.
  if (
    !(await isSlackAuthorDomainAllowed({
      allowedBotUserIds: args.allowedBotUserIds,
      allowedDomains: args.allowedDomains,
      state: args.state,
      teamId,
      user: event.user,
    }))
  ) {
    return true;
  }
  const text = stripLeadingBotMention(rawText, {
    botUserId: args.adapter.botUserId,
    stripLeadingSlackMentionToken: true,
  });
  if (!text.trim()) return true;
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId,
      createdAtMs,
      delivery: "defer",
      destination,
      inboundMessageId,
      input: {
        authorId: userId,
        authorIdentityId: await resolveActorIdentityId(
          getSqlExecutor(),
          createSlackActor(teamId, userId, null),
        ),
        metadata: codeChannelMessageMetadata({
          channelId,
          messageTs: event.ts,
          teamId,
          userId,
        }),
        text,
      },
      receivedAtMs: args.receivedAtMs,
      source: "slack",
    },
    queue: args.queue,
    state: args.state,
  });
  return true;
}
