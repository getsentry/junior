/**
 * Destination-visible pause notice for the consecutive automated-turn limit.
 *
 * Best-effort: a failed post must not fail the Turn or re-enable event wakes.
 * The consecutive-turn limit claims the notice slot before this post. Clear that
 * claim when the post fails or is skipped so a later paused wake can try again.
 */
import type { Destination } from "@sentry/junior-plugin-api";
import { getConversationStore } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import {
  buildAutomatedTurnLimitResponse,
  clearAutomatedTurnLimitNoticeClaim,
  type AutomatedTurnLimitScope,
  type AutomatedTurnLimitUpdate,
} from "@/chat/services/automated-turn-limit";
import { postSlackMessage } from "@/chat/slack/outbound";

async function releaseFailedNoticeClaim(args: {
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
}): Promise<void> {
  try {
    await clearAutomatedTurnLimitNoticeClaim(args);
  } catch (error) {
    logException(error, "automated_turn_limit.notice_claim_clear_failed");
  }
}

/** Post the pause notice for one Conversation Location when known. */
export async function postAutomatedTurnLimitNoticeForConversation(args: {
  conversationId: string;
  maxTurns: number;
  nowMs?: number;
  resumeIn?: "thread" | "channel";
  scope?: AutomatedTurnLimitScope;
}): Promise<boolean> {
  const scope =
    args.scope ??
    ({
      kind: "conversation",
      conversationId: args.conversationId,
    } satisfies AutomatedTurnLimitScope);
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
      await releaseFailedNoticeClaim({
        nowMs: args.nowMs,
        scope,
      });
      return false;
    }
    await postSlackMessage({
      channelId: location.channelId,
      text: buildAutomatedTurnLimitResponse({
        maxTurns: args.maxTurns,
        resumeIn: args.resumeIn ?? "thread",
      }),
      ...(location.threadTs ? { threadTs: location.threadTs } : undefined),
    });
    return true;
  } catch (error) {
    logException(error, "automated_turn_limit.notice_failed", {
      conversationId: args.conversationId,
    });
    await releaseFailedNoticeClaim({
      nowMs: args.nowMs,
      scope,
    });
    return false;
  }
}

/** Post the pause notice for one Slack Destination. */
export async function postAutomatedTurnLimitNoticeForDestination(args: {
  destination: Destination;
  maxTurns: number;
  nowMs?: number;
  resumeIn?: "thread" | "channel";
  scope?: AutomatedTurnLimitScope;
  threadTs?: string;
}): Promise<boolean> {
  const scope =
    args.scope ??
    ({
      kind: "destination",
      destination: args.destination,
    } satisfies AutomatedTurnLimitScope);
  if (args.destination.platform !== "slack") {
    logWarn("automated_turn_limit.notice_skipped", {
      "app.automated_turn_limit.reason": "unsupported_destination",
    });
    await releaseFailedNoticeClaim({
      nowMs: args.nowMs,
      scope,
    });
    return false;
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
    return true;
  } catch (error) {
    logException(error, "automated_turn_limit.notice_failed", {
      "app.slack.channel_id": args.destination.channelId,
      "app.slack.team_id": args.destination.teamId,
    });
    await releaseFailedNoticeClaim({
      nowMs: args.nowMs,
      scope,
    });
    return false;
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
  nowMs?: number;
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
      nowMs: args.nowMs,
      resumeIn: "thread",
      scope: {
        kind: "conversation",
        conversationId: args.conversationId,
      },
    });
    return;
  }
  if (args.destination) {
    await postAutomatedTurnLimitNoticeForDestination({
      destination: args.destination,
      maxTurns: args.maxTurns,
      nowMs: args.nowMs,
      resumeIn: "channel",
      scope: { kind: "destination", destination: args.destination },
      threadTs: args.threadTs,
    });
    return;
  }
  await postAutomatedTurnLimitNoticeForConversation({
    conversationId: args.conversationId,
    maxTurns: args.maxTurns,
    nowMs: args.nowMs,
    resumeIn: args.update.resumeIn,
    scope: {
      kind: "conversation",
      conversationId: args.conversationId,
    },
  });
}
