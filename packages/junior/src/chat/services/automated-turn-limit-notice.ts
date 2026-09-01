/**
 * Destination-visible pause notice for the consecutive automated-turn limit.
 *
 * Best-effort: a failed post must not fail the Turn or re-enable event wakes.
 */
import type { Destination } from "@sentry/junior-plugin-api";
import { getConversationStore } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import {
  buildAutomatedTurnLimitResponse,
  type AutomatedTurnLimitUpdate,
} from "@/chat/services/automated-turn-limit";
import { postSlackMessage } from "@/chat/slack/outbound";

/** Post the pause notice for one Conversation Location when known. */
export async function postAutomatedTurnLimitNoticeForConversation(args: {
  conversationId: string;
  maxTurns: number;
  resumeIn?: "thread" | "channel";
}): Promise<void> {
  try {
    const conversation = await getConversationStore().get({
      conversationId: args.conversationId,
    });
    const location = conversation?.location;
    if (!location || location.provider !== "slack") {
      logWarn("automated_turn_limit.notice_skipped", {
        conversationId: args.conversationId,
        "app.automated_turn_limit.reason": location
          ? "unsupported_location"
          : "missing_location",
      });
      return;
    }
    await postSlackMessage({
      channelId: location.channelId,
      text: buildAutomatedTurnLimitResponse({
        maxTurns: args.maxTurns,
        resumeIn: args.resumeIn ?? "thread",
      }),
      ...(location.threadTs ? { threadTs: location.threadTs } : undefined),
    });
  } catch (error) {
    logException(error, "automated_turn_limit.notice_failed", {
      conversationId: args.conversationId,
    });
  }
}

/** Post the pause notice for one Slack Destination. */
export async function postAutomatedTurnLimitNoticeForDestination(args: {
  destination: Destination;
  maxTurns: number;
  resumeIn?: "thread" | "channel";
  threadTs?: string;
}): Promise<void> {
  if (args.destination.platform !== "slack") {
    logWarn("automated_turn_limit.notice_skipped", {
      "app.automated_turn_limit.reason": "unsupported_destination",
    });
    return;
  }
  try {
    await postSlackMessage({
      channelId: args.destination.channelId,
      text: buildAutomatedTurnLimitResponse({
        maxTurns: args.maxTurns,
        resumeIn: args.resumeIn ?? "channel",
      }),
      ...(args.threadTs ? { threadTs: args.threadTs } : undefined),
    });
  } catch (error) {
    logException(error, "automated_turn_limit.notice_failed", {
      "app.slack.channel_id": args.destination.channelId,
      "app.slack.team_id": args.destination.teamId,
    });
  }
}

/**
 * Post the pause notice after a finished Turn hits the limit.
 * Prefer the Conversation Location so thread watches stay in-thread.
 */
export async function maybePostAutomatedTurnLimitNotice(args: {
  conversationId: string;
  destination?: Destination;
  maxTurns: number;
  threadTs?: string;
  update: AutomatedTurnLimitUpdate | undefined;
}): Promise<void> {
  if (!args.update?.shouldPostNotice) {
    return;
  }
  if (args.update.resumeIn === "thread") {
    await postAutomatedTurnLimitNoticeForConversation({
      conversationId: args.conversationId,
      maxTurns: args.maxTurns,
      resumeIn: "thread",
    });
    return;
  }
  if (args.destination) {
    await postAutomatedTurnLimitNoticeForDestination({
      destination: args.destination,
      maxTurns: args.maxTurns,
      resumeIn: "channel",
      threadTs: args.threadTs,
    });
    return;
  }
  await postAutomatedTurnLimitNoticeForConversation({
    conversationId: args.conversationId,
    maxTurns: args.maxTurns,
    resumeIn: args.update.resumeIn,
  });
}
