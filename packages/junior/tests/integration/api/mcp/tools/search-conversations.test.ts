import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_ORIGIN,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

describe("searchConversations MCP tool", () => {
  it("returns only the Conversations that the viewer takes part in", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000100",
      email: MCP_TEST_VIEWER,
      title: "Viewer launch plan",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000200",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other person's roadmap",
    });
    const call = await connectMcpTools();

    const result = await call("searchConversations");

    expect(result).toEqual({
      content: [
        { type: "text", text: JSON.stringify(result.structuredContent) },
      ],
      structuredContent: {
        conversations: [
          {
            conversationId: "slack:C123:1700000000.000100",
            title: "Viewer launch plan",
            status: "idle",
            surface: "slack",
            startedAt: expect.any(String),
            lastSeenAt: expect.any(String),
            url: `${MCP_TEST_ORIGIN}/conversations/${encodeURIComponent("slack:C123:1700000000.000100")}`,
          },
        ],
      },
    });
  });

  it("matches the query against the viewer's Conversations only", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000300",
      email: MCP_TEST_VIEWER,
      title: "Budget review",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000400",
      email: MCP_TEST_VIEWER,
      title: "Launch plan",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000500",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Budget forecast",
    });
    const call = await connectMcpTools();

    const result = await call("searchConversations", { q: "budget" });

    expect(result.structuredContent).toEqual({
      conversations: [
        expect.objectContaining({
          conversationId: "slack:C123:1700000000.000300",
        }),
      ],
    });
  });
});
