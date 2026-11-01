/**
 * Pause notice for the consecutive automated-turn limit.
 *
 * Best-effort: a failed post must not fail the Turn or re-enable event wakes.
 * The consecutive-turn limit claims the notice slot before this post. Clear that
 * claim when the post fails or is skipped so a later paused wake can try again.
 */
import { getConversationStore } from "@/chat/db";
import { logException, logWarn } from "@/chat/logging";
import {
  buildAutomatedTurnLimitResponse,
  clearAutomatedTurnLimitNoticeClaim,
} from "@/chat/services/automated-turn-limit";
import type { Source } from "@sentry/junior-plugin-api";
import { resolveSlackReplyTarget, sendSlackReply } from "@/chat/slack/reply";

async function releaseFailedNoticeClaim(args: {
  conversationId: string;
  nowMs?: number;
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
  /** Source of the Turn that hit the limit, when a Turn posts the notice. */
  source?: Source;
}): Promise<boolean> {
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
    logException(error, "automated_turn_limit.notice_failed", {
      conversationId: args.conversationId,
    });
    await releaseFailedNoticeClaim({
      conversationId: args.conversationId,
      nowMs: args.nowMs,
    });
    return false;
  }
}
