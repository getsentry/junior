import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

describe("setConversationSubscription MCP tool", () => {
  it("unsubscribes the viewer and cannot reach another person's Conversation", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000400",
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000500",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const own = await call("setConversationSubscription", {
      conversationId: "slack:C123:1700000000.000400",
      subscribed: false,
    });
    const other = await call("setConversationSubscription", {
      conversationId: "slack:C123:1700000000.000500",
      subscribed: false,
    });

    expect(own.structuredContent).toEqual({
      archivedAt: expect.any(String),
      subscribed: false,
    });
    expect(await call("searchConversations")).toMatchObject({
      structuredContent: { conversations: [] },
    });
    expect(other).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
