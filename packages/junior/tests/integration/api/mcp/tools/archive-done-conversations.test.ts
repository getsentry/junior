import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

describe("archiveDoneConversations MCP tool", () => {
  it("keeps Conversations that had activity during the wait time", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000300",
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    const call = await connectMcpTools();

    const result = await call("archiveDoneConversations");
    const listed = await call("searchConversations");

    expect(result.structuredContent).toEqual({ archived: 0 });
    expect(listed.structuredContent).toEqual({
      conversations: [
        expect.objectContaining({
          conversationId: "slack:C123:1700000000.000300",
        }),
      ],
    });
  });
});
