import { describe, expect, it } from "vitest";
import { createConversationWorkQueueTestAdapter } from "../../../../fixtures/conversation-work";
import {
  connectMcpTools,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";

mockMcpDashboardConfig();

describe("createConversation MCP tool", () => {
  it("starts a Conversation, queues its Turn, and dedupes a retry", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const call = await connectMcpTools(MCP_TEST_VIEWER, "", {
      conversationWorkQueue: () => queue,
    });

    const created = await call("createConversation", {
      idempotencyKey: "first-question",
      message: "Is ingestion healthy?",
    });
    const retried = await call("createConversation", {
      idempotencyKey: "first-question",
      message: "Is ingestion healthy?",
    });
    const { conversationId } = created.structuredContent as {
      conversationId: string;
    };
    const listed = await call("searchConversations");

    expect(created.structuredContent).toEqual({
      conversationId: expect.any(String),
      cursor: expect.any(String),
      messageId: expect.any(String),
      pendingMessages: [
        expect.objectContaining({ text: "Is ingestion healthy?" }),
      ],
      status: "accepted",
      url: expect.stringContaining("/conversations/"),
    });
    expect(retried.structuredContent).toEqual({
      ...(created.structuredContent as object),
      status: "duplicate",
    });
    expect(queue.takeMessageFor(conversationId)).toBeDefined();
    expect(listed.structuredContent).toEqual({
      conversations: [expect.objectContaining({ conversationId })],
    });
  });

  it("is not available without the conversations:write scope", async () => {
    const call = await connectMcpTools(MCP_TEST_VIEWER, "conversations:read");

    const result = await call("createConversation", { message: "Hello" });

    expect(result).toMatchObject({ isError: true });
  });
});
