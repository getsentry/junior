import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encodeConversationCursor } from "@/api/conversations/cursor";
import { appendConversationMessageForViewer } from "@/api/conversations/create";
import {
  readConversationLastEventSeq,
  readConversationMessageEventSeq,
} from "@/api/conversations/event-page";
import { steerConversationPendingMessagesForViewer } from "@/api/conversations/steer-pending-messages";
import { conversationPendingMessageDeliverySchema } from "@/api/schema/conversation-pending-messages";
import { logException } from "@/chat/logging";
import { getSqlExecutor } from "@/chat/db";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import {
  mcpAcceptedMessageSchema,
  mcpConversationIdSchema,
  mcpIdempotencyKeySchema,
  mcpMessageTextSchema,
  readMcpPendingWorkAfterSend,
} from "../conversation";
import {
  apiToolError,
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/**
 * Register `sendMessage`, which adds the user's message to a Conversation.
 * Junior reads it in a new Turn, or after the running Turn.
 */
export function registerSendMessageTool(
  server: McpServer,
  { attachmentStorage, queue, user }: McpToolContext,
): void {
  server.registerTool(
    "sendMessage",
    {
      title: "Send message",
      description:
        "Send a message as you to one of your conversations. The agent answers in the background. When a turn is running, the message waits for it unless `delivery` is `interrupt`. Returns the messages that no turn has read yet and a `cursor`. Pass the `cursor` as `after` to getConversation to read the reply.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        message: mcpMessageTextSchema,
        idempotencyKey: mcpIdempotencyKeySchema,
        delivery: conversationPendingMessageDeliverySchema
          .default("defer")
          .describe(
            "`defer` waits for the running turn to end. `interrupt` joins the running turn at its next safe step. Use it to correct or add to the work in progress.",
          ),
      },
      outputSchema: mcpAcceptedMessageSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
    },
    async ({ conversationId, delivery, idempotencyKey, message }) => {
      if (!(await isConversationParticipant(user, conversationId))) {
        return mcpToolError("Conversation not found.");
      }
      // Read the position before the send, so the reply always comes after it.
      const lastSeq = await readConversationLastEventSeq(
        getSqlExecutor(),
        conversationId,
      );
      let accepted;
      try {
        accepted = await appendConversationMessageForViewer(
          user,
          conversationId,
          { idempotencyKey: idempotencyKey ?? randomUUID(), message },
          { attachmentStorage, queue },
        );
      } catch (error) {
        return apiToolError(error);
      }
      if (delivery === "interrupt") {
        // The message already landed. If steering fails, it waits for the
        // running Turn, and `pendingMessages` shows `defer`.
        try {
          await steerConversationPendingMessagesForViewer(
            user,
            conversationId,
            {
              inboundMessageIds: [accepted.messageId],
            },
          );
        } catch (error) {
          logException(error, "mcp.send_message.steer.failed", {
            "gen_ai.conversation.id": conversationId,
          });
        }
      }
      // A retry can come after a Turn read the message and replied. Start
      // before the message then, so the cursor does not skip the reply.
      const messageSeq =
        accepted.status === "duplicate"
          ? await readConversationMessageEventSeq(
              getSqlExecutor(),
              accepted.conversationId,
              accepted.messageId,
            )
          : undefined;
      return mcpToolResult({
        ...accepted,
        ...(await readMcpPendingWorkAfterSend(user, accepted.conversationId)),
        cursor: encodeConversationCursor({
          conversationId: accepted.conversationId,
          seq: messageSeq === undefined ? lastSeq : messageSeq - 1,
        }),
        url: getDashboardConversationLink(accepted.conversationId),
      });
    },
  );
}
