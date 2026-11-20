import type { SlackAdapter } from "@chat-adapter/slack";
import { ThreadImpl, type Message, type StateAdapter } from "chat";
import {
  stopConversation,
  type StopConversationResult,
  type StopRequest,
} from "@/chat/conversations/stop";
import type { ConversationStore } from "@/chat/conversations/store";
import { createSlackDestination } from "@/chat/destination";
import { SubscribedReplyReason } from "@/chat/services/subscribed-decision";
import type { SlackInstallationContext } from "@/chat/slack/adapter-context";
import { createSlackWebApiStatusSender } from "@/chat/slack/assistant-thread/status-send";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  clearSlackPendingReactions,
  slackInboundMessageId,
} from "@/chat/task-execution/slack-work";
import { saveSkippedSlackMessage } from "./slack-skipped-message";

/** Acknowledge a Slack stop. */
export const SLACK_STOP_ACK = "Stopped.";

/**
 * Claim Slack's native stop button press. Slack sends a retry with the same
 * `event_ts`, so the claim dedupes it, and the press time is the stop time.
 */
export function slackStopButtonRequest(args: {
  channelId: string;
  conversationId: string;
  eventTs: string;
  installation: SlackInstallationContext;
}): StopRequest {
  return {
    conversationId: args.conversationId,
    createdAtMs: Math.floor(Number(args.eventTs) * 1_000),
    destination: createSlackDestination({
      channelId: args.channelId,
      teamId: args.installation.teamId,
    }),
    inboundMessageId: slackInboundMessageId({
      conversationId: args.conversationId,
      installation: args.installation,
      slackId: `agent_session_stopped:${args.eventTs}`,
    }),
    source: "slack",
  };
}

/**
 * Stop a Slack thread's Conversation for the `stop` keyword or Slack's native
 * agent stop button. The thread stays subscribed, and the next person input
 * that reaches the worker ends the stop. A keyword stop message is saved as
 * a skipped Message and never enters the mailbox. Slack does not leave the
 * `processing` status by itself, so clear the status even when no work runs.
 *
 * Slack sends one mention as both `message` and `app_mention`, and it retries
 * events. The stop claims its `inboundMessageId` in the mailbox, the same
 * duplicate guard that ordinary messages get, so a second delivery stops
 * nothing and posts no ack. The keyword uses its message id and the button
 * its `event_ts`. This replaces the old stop watermark's duplicate guard.
 * https://docs.slack.dev/reference/events/agent_session_stopped
 */
export async function handleSlackStop(args: {
  adapter: SlackAdapter;
  canonicalThreadId: string;
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  queue: ConversationWorkQueue;
  /** The message or button press that asked for the stop. */
  request?: StopRequest | undefined;
  /** The Slack thread whose status the stop clears. */
  slackThread?: { channelId: string; threadTs: string } | undefined;
  state: StateAdapter;
  /** The `stop` keyword message. Omit it for the native stop button. */
  stopMessage?: { message: Message; stopReason: string };
}): Promise<void> {
  if (args.stopMessage) {
    await saveSkippedSlackMessage({
      conversationId: args.conversationId,
      message: args.stopMessage.message,
      skippedReason: `${SubscribedReplyReason.ThreadOptOut}:${args.stopMessage.stopReason}`,
    });
  }
  let duplicate = false;
  let stopped: StopConversationResult;
  try {
    stopped = await stopConversation({
      conversationId: args.conversationId,
      conversationStore: args.conversationStore,
      message: args.request,
      queue: args.queue,
      state: args.state,
    });
    duplicate = stopped.status === "duplicate";
  } finally {
    // The person asked to stop, so Slack stops showing the status either way.
    // A duplicate leaves the status of newer work alone.
    if (!duplicate) {
      await createSlackWebApiStatusSender({
        channelId: args.slackThread?.channelId,
        threadTs: args.slackThread?.threadTs,
      })("");
    }
  }
  if (stopped.status === "duplicate") {
    return;
  }
  if (stopped.status === "requested") {
    await clearSlackPendingReactions({
      getSlackAdapter: () => args.adapter,
      messages: stopped.pendingMessages,
      state: args.state,
    });
  }

  if (!args.stopMessage && stopped.status !== "requested") {
    // A button press with no work to stop needs no reply.
    return;
  }

  const thread = new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: args.canonicalThreadId,
    channelId: args.adapter.channelIdFromThreadId(args.canonicalThreadId),
    isDM: args.adapter.isDM(args.canonicalThreadId),
  });
  await thread.post(SLACK_STOP_ACK);
}
