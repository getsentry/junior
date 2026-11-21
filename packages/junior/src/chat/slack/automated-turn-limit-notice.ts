/**
 * Pause notice for the consecutive automated-turn limit.
 *
 * Best-effort: a failed post must not fail the Turn or re-enable event wakes.
 * The consecutive-turn limit claims the notice slot before this post. Clear that
 * claim when the post fails or is skipped so a later paused wake can try again.
 */
import { enqueueAgentMessageToParent } from "@/chat/agent-invocations/agent-message";
import { readChildConversationSender } from "@/chat/agent-invocations/child-input";
import { getLatestAgentInvocationForConversation } from "@/chat/agent-invocations/store";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationStore } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { logException, logWarn } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  buildAutomatedTurnLimitResponse,
  clearAutomatedTurnLimitNoticeClaim,
  type AutomatedTurnLimitUpdate,
} from "@/chat/services/automated-turn-limit";
import type { Source } from "@sentry/junior-plugin-api";
import { resolveSlackReplyTarget, sendSlackReply } from "@/chat/slack/reply";

async function releaseFailedNoticeClaim(args: {
  conversationId: string;
  nowMs?: number | undefined;
}): Promise<void> {
  try {
    await clearAutomatedTurnLimitNoticeClaim(args);
  } catch (error) {
    logException(error, "automated_turn_limit.notice.claim_clear_failed");
  }
}

/**
 * Tell the parent of a paused child agent that its Watch Events are dropped.
 * A parent message resets the limit. Without this message, nobody learns of
 * the pause, because a child has no Location.
 */
async function sendNoticeToParent(args: {
  conversationId: string;
  maxTurns: number;
  nowMs: number;
  queue: ConversationWorkQueue;
}): Promise<boolean> {
  const sender =
    (await getLatestAgentInvocationForConversation(args.conversationId)) ??
    (await readChildConversationSender(args.conversationId));
  if (!sender) return false;
  await enqueueAgentMessageToParent({
    actor: EVENT_SYSTEM_ACTOR,
    messageKey: `automated-turn-limit:${args.nowMs}`,
    nowMs: args.nowMs,
    queue: args.queue,
    sender,
    text: `I stopped taking Watch Events after ${args.maxTurns} automated Turns in a row with no message from you or a person. Events that arrive now are dropped. Message me to continue.`,
  });
  return true;
}

/**
 * Post the pause notice for one Conversation Location when known. A child
 * agent has no Location, so with `queue` its parent gets the notice, as it
 * gets a blocked report.
 */
export async function postAutomatedTurnLimitNoticeForConversation(args: {
  conversationId: string;
  maxTurns: number;
  nowMs?: number | undefined;
  /** Queue that wakes the parent of a child agent. */
  queue?: ConversationWorkQueue | undefined;
  /** Source of the Turn that hit the limit, when a Turn posts the notice. */
  source?: Source | undefined;
}): Promise<boolean> {
  try {
    const conversation = await getConversationStore().get({
      conversationId: args.conversationId,
    });
    if (
      conversation &&
      turnBehavior({ kind: conversation.kind, personInput: false }).tools
        .reportBlocked === "parent" &&
      args.queue &&
      (await sendNoticeToParent({
        conversationId: args.conversationId,
        maxTurns: args.maxTurns,
        nowMs: args.nowMs ?? Date.now(),
        queue: args.queue,
      }))
    ) {
      return true;
    }
    // A child posts nothing to Slack. Its Location is only a copy of its
    // root's.
    const location = conversation?.parentConversationId
      ? undefined
      : conversation?.location;
    // A thread that its Conversation detached from gets no notice.
    if (
      !location ||
      location.provider !== "slack" ||
      conversation?.deliveryPausedAtMs !== undefined
    ) {
      logWarn("automated_turn_limit.notice.skipped", {
        conversationId: args.conversationId,
        "app.automated_turn_limit.reason": !location
          ? "missing_location"
          : location.provider !== "slack"
            ? "unsupported_location"
            : "delivery_paused",
      });
      await releaseFailedNoticeClaim({
        conversationId: args.conversationId,
        nowMs: args.nowMs,
      });
      return false;
    }
    await sendSlackReply({
      // The Location is the only Slack channel this path knows.
      ...resolveSlackReplyTarget({
        destination: location,
        location,
        source: args.source,
      }),
      conversationId: args.conversationId,
      text: buildAutomatedTurnLimitResponse({
        maxTurns: args.maxTurns,
      }),
    });
    return true;
  } catch (error) {
    logException(error, "automated_turn_limit.notice.failed", {
      conversationId: args.conversationId,
    });
    await releaseFailedNoticeClaim({
      conversationId: args.conversationId,
      nowMs: args.nowMs,
    });
    return false;
  }
}

/** Post the pause notice after a finished Turn hits the limit. */
export async function maybePostAutomatedTurnLimitNotice(args: {
  conversationId: string;
  maxTurns: number;
  nowMs?: number;
  source?: Source;
  update: AutomatedTurnLimitUpdate | undefined;
}): Promise<void> {
  if (!args.update?.shouldPostNotice) {
    return;
  }
  await postAutomatedTurnLimitNoticeForConversation({
    conversationId: args.conversationId,
    maxTurns: args.maxTurns,
    nowMs: args.nowMs,
    source: args.source,
  });
}
