import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encodeConversationCursor } from "@/api/conversations/cursor";
import { appendConversationMessageForViewer } from "@/api/conversations/create";
import {
  readConversationLastEventSeq,
  readConversationMessageEventSeq,
} from "@/api/conversations/event-page";
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
        "Send a message as you to one of your conversations. The agent answers in the background. When a turn is running, the message waits for it. Returns the messages that no turn has read yet and a `cursor`. Pass the `cursor` as `after` to getConversation to read the reply.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        message: mcpMessageTextSchema,
        idempotencyKey: mcpIdempotencyKeySchema,
      },
      outputSchema: mcpAcceptedMessageSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
    },
    async ({ conversationId, idempotencyKey, message }) => {
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
