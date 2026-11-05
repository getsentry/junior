import { describe, expect, it } from "vitest";
import { createConversationWorkQueueTestAdapter } from "../../../../fixtures/conversation-work";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

describe("sendMessage MCP tool", () => {
  it("queues a follow-up for the Conversation", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const call = await connectMcpTools(MCP_TEST_VIEWER, "", {
      conversationWorkQueue: () => queue,
    });
    const { conversationId } = (
      await call("createConversation", { message: "Is ingestion healthy?" })
    ).structuredContent as { conversationId: string };

    const sent = await call("sendMessage", {
      conversationId,
      message: "Did the relay deploy finish?",
    });
    const { messageId } = sent.structuredContent as { messageId: string };
    // No Turn ran, so both messages still wait in the mailbox.
    const read = await call("getConversation", { conversationId });
    const cancelled = await call("cancelQueuedMessages", { conversationId });

    const pendingMessages = [
      expect.objectContaining({
        delivery: "defer",
        text: "Is ingestion healthy?",
      }),
      {
        author: MCP_TEST_VIEWER,
        createdAt: expect.any(String),
        delivery: "defer",
        messageId,
        text: "Did the relay deploy finish?",
      },
    ];
    expect(sent.structuredContent).toEqual({
      conversationId,
      messageId: expect.any(String),
      pendingMessages,
      status: "accepted",
      url: expect.stringContaining("/conversations/"),
    });
    expect(read.structuredContent).toMatchObject({ pendingMessages });
    expect(cancelled.structuredContent).toEqual({ cancelledMessages: 2 });
  });

  it("reports another person's Conversation as not found", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000400",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const result = await call("sendMessage", {
      conversationId: "slack:C123:1700000000.000400",
      message: "Hello",
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
