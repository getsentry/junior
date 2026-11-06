import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

describe("stopConversation MCP tool", () => {
  it("reports no work when no Turn is running", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000300",
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    const call = await connectMcpTools();

    const result = await call("stopConversation", {
      conversationId: "slack:C123:1700000000.000300",
    });

    expect(result.structuredContent).toEqual({
      status: "no_work",
      droppedMessages: 0,
    });
  });

  it("reports another person's Conversation as not found", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000400",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const result = await call("stopConversation", {
      conversationId: "slack:C123:1700000000.000400",
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
