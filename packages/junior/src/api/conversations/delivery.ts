import type { User } from "@sentry/junior-plugin-api";
import {
  canPauseConversationDelivery,
  pauseConversationDelivery,
  resumeConversationDelivery,
} from "@/chat/conversations/delivery-pause";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { getConversationStore, getDb } from "@/chat/db";
import { runBestEffort } from "@/chat/logging";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";
import { postSlackDetachNotice } from "@/chat/slack/detach-notice";
import { throwApiError } from "../http";
import type {
  ConversationDeliveryBody,
  ConversationDeliveryResponse,
} from "../schema/conversation-delivery";
import { readConversationAccessFromSql } from "./access";

/**
 * Detach a root from its Location, or attach it again. Only a participant
 * can change it, the same as rename. A mention in the Location attaches it
 * again too. Each detach tells the Slack thread once.
 */
export async function setConversationDeliveryForViewer(
  viewer: User,
  conversationId: string,
  body: ConversationDeliveryBody,
): Promise<ConversationDeliveryResponse> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  const conversation = access.get(conversationId)?.isParticipant
    ? await getConversationStore().get({ conversationId })
    : undefined;
  if (!conversation) throwApiError(404, "Conversation not found.");
  if (!canPauseConversationDelivery(conversation)) {
    throwApiError(409, "Only a conversation with a Slack thread can detach.");
  }
  if (body.paused) {
    const detached = await pauseConversationDelivery(conversationId);
    const location = conversation.location;
    if (detached && location?.provider === "slack") {
      // Best-effort: the detach is saved, and a retry would not post again.
      await runBestEffort(
        () =>
          runWithSlackInstallation({
            adapter: getProductionSlackAdapter(),
            installation: { teamId: location.teamId },
            task: () =>
              postSlackDetachNotice({
                actorName: viewer.displayName ?? viewer.email,
                conversationId,
                location,
              }),
          }),
        "conversation.detach_notice.failed",
        { "app.conversation.id": conversationId },
      );
    }
  } else {
    await resumeConversationDelivery(conversationId);
  }
  return { paused: body.paused };
}
