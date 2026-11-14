/**
 * Show a channel Thread's work as the session status of its code channel.
 * https://docs.slack.dev/reference/methods/agents.sessions.setStatus
 */
import { and, eq } from "drizzle-orm";
import { isChannelThread } from "@/chat/conversations/channel-thread";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { getConversationStore, getDb } from "@/chat/db";
import { logException } from "@/chat/logging";
import type { MailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { juniorReviewItems } from "@/db/schema";
import { setCodeChannelStatus, type CodeChannelSessionStatus } from "./api";

type TurnWorker = (
  context: ConversationWorkerContext,
  work: MailboxTurnWork,
) => Promise<ConversationWorkerResult>;

async function hasOpenReviewItem(conversationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: juniorReviewItems.id })
    .from(juniorReviewItems)
    .where(
      and(
        eq(juniorReviewItems.addedByConversationId, conversationId),
        eq(juniorReviewItems.kind, "action"),
        eq(juniorReviewItems.status, "open"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function trySetStatus(
  conversationId: string,
  channelId: string,
  status: CodeChannelSessionStatus,
): Promise<void> {
  // After a stop, Slack forbids `agents.*` calls until a person writes again.
  if ((await getConversationStoppedAtMs(conversationId)) !== undefined) return;
  try {
    await setCodeChannelStatus({ channelId, status });
  } catch (error) {
    // The status only shows progress. A failed call must not fail the Turn.
    logException(error, "slack.code_channel.status_failed");
  }
}

/**
 * Wrap the Conversation loop's Turn worker so that each Turn of a channel
 * Thread in a Slack code channel shows `processing`, then `active`, or
 * `suspended` while the Thread waits on an open Review item.
 */
export function withCodeChannelStatus(worker: TurnWorker): TurnWorker {
  return async (context, work) => {
    const conversation = await getConversationStore().get({
      conversationId: context.conversationId,
    });
    const location = conversation?.location;
    if (
      location?.provider !== "slack" ||
      location.threadTs ||
      !(await isChannelThread(conversation))
    ) {
      return await worker(context, work);
    }
    const { conversationId } = context;
    await trySetStatus(conversationId, location.channelId, "processing");
    try {
      return await worker(context, work);
    } finally {
      await trySetStatus(
        conversationId,
        location.channelId,
        (await hasOpenReviewItem(conversationId)) ? "suspended" : "active",
      );
    }
  };
}
