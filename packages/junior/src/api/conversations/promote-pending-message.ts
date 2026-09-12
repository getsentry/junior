import type { User } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb } from "@/chat/db";
import {
  ensureConversationWake,
  promoteHumanFacingPendingMessage,
} from "@/chat/task-execution/store";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { throwApiError } from "../http";
import type {
  PromoteConversationPendingMessageBody,
  PromoteConversationPendingMessageResponse,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/** Promote one queued Message into the active Turn for a participant. */
export async function promoteConversationPendingMessageForViewer(
  viewer: User,
  conversationId: string,
  body: PromoteConversationPendingMessageBody,
): Promise<PromoteConversationPendingMessageResponse> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(
      403,
      "Only conversation participants can steer queued messages.",
    );
  }

  const nowMs = Date.now();
  let result: Awaited<ReturnType<typeof promoteHumanFacingPendingMessage>>;
  try {
    result = await promoteHumanFacingPendingMessage({
      conversationId,
      inboundMessageId: body.inboundMessageId,
      conversationStore: getConversationStore(),
      nowMs,
    });
    if (result.status === "promoted") {
      await ensureConversationWake({
        conversationId,
        conversationStore: getConversationStore(),
        idempotencyKey: `steer:${body.inboundMessageId}:${nowMs}`,
        nowMs,
        queue: getVercelConversationWorkQueue(),
      });
    }
  } catch (error) {
    throwApiError(500, "Unable to steer queued message.", error);
  }
  if (result.status === "not_found") {
    throwApiError(404, "Queued message not found.");
  }
  return {
    conversationId,
    inboundMessageId: body.inboundMessageId,
    status: "promoted",
  };
}
