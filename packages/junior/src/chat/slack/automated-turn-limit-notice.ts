/**
 * Stop and notice for the consecutive automated-turn limit.
 *
 * The notice is best-effort: a failed post must not fail the Turn or undo the
 * stop.
 */
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import { stopConversationAndChildAgents } from "@/chat/conversations/stop";
import { getConversationStore } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import {
  buildAutomatedTurnLimitResponse,
  type AutomatedTurnLimitUpdate,
} from "@/chat/services/automated-turn-limit";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { Source } from "@sentry/junior-plugin-api";
import { resolveSlackReplyTarget, sendSlackReply } from "@/chat/slack/reply";

/**
 * Post the stop notice to the Conversation Location when known. A child
 * agent posts none: its parent sees it as stopped in `listAgents`.
 */
async function postAutomatedTurnLimitNotice(args: {
  conversationId: string;
  maxTurns: number;
  /** Source of the Turn that hit the limit. */
  source?: Source | undefined;
}): Promise<void> {
  try {
    const conversation = await getConversationStore().get({
      conversationId: args.conversationId,
    });
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
      return;
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
  } catch (error) {
    logException(error, "automated_turn_limit.notice.failed", {
      conversationId: args.conversationId,
    });
  }
}

/**
 * Stop the Conversation tree after a finished Turn reaches the automated-turn
 * limit, then post the notice. Person input that already waits ends the loop
 * by itself, so then nothing stops.
 */
export async function stopAtAutomatedTurnLimit(args: {
  conversationId: string;
  maxTurns: number;
  source?: Source;
  update: AutomatedTurnLimitUpdate | undefined;
}): Promise<void> {
  if (!args.update?.reached) {
    return;
  }
  const pending =
    (await getConversationWorkState({ conversationId: args.conversationId }))
      ?.messages ?? [];
  if (pending.some((message) => isPersonInput(message.source))) {
    return;
  }
  const nowMs = Date.now();
  await stopConversationAndChildAgents({
    conversationId: args.conversationId,
    finishedRunOf: args.conversationId,
    nowMs,
    stoppedAtMs: nowMs,
  });
  await postAutomatedTurnLimitNotice({
    conversationId: args.conversationId,
    maxTurns: args.maxTurns,
    source: args.source,
  });
}
