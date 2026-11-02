/** Own what every MCP tool gets: its request context and result shapes. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HTTPException } from "hono/http-exception";
import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { readConversationAccessFromSql } from "@/api/conversations/access";

/** Services and the authenticated user for one MCP request. */
export interface McpToolContext {
  queue: ConversationWorkQueue;
  user: User;
}

/**
 * Return one structured tool result. The text block holds the same JSON, as
 * the MCP spec recommends for clients that do not read `structuredContent`.
 */
export function mcpToolResult<T extends Record<string, unknown>>(
  result: T,
): { content: [{ type: "text"; text: string }]; structuredContent: T } {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** Return a tool error that the client model can read and repair. */
export function mcpToolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Turn a client error from a shared API function, such as a `404` or a
 * `409`, into a tool error. Rethrow every other failure.
 */
export function apiToolError(error: unknown): CallToolResult {
  if (error instanceof HTTPException && error.status < 500) {
    return mcpToolError(error.message);
  }
  throw error;
}

/**
 * Return whether `user` started or takes part in a Conversation. MCP tools
 * read and change only these Conversations, the same set that
 * `listConversations` shows.
 */
export async function isConversationParticipant(
  user: User,
  conversationId: string,
): Promise<boolean> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    user,
  );
  return access.get(conversationId)?.isParticipant ?? false;
}
