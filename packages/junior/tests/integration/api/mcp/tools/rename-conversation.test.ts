import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

const CONVERSATION_ID = "slack:C123:1700000000.000400";

describe("renameConversation MCP tool", () => {
  it("renames a Conversation and returns the stored title", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Generated title",
    });
    const call = await connectMcpTools();

    const renamed = await call("renameConversation", {
      conversationId: CONVERSATION_ID,
      title: "  Checkout fix  ",
    });
    const read = await call("getConversation", {
      conversationId: CONVERSATION_ID,
    });

    expect(renamed.structuredContent).toEqual({ title: "Checkout fix" });
    expect(read.structuredContent).toMatchObject({
      conversation: { title: "Checkout fix" },
    });
  });

  it("reports another person's Conversation as not found", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const result = await call("renameConversation", {
      conversationId: CONVERSATION_ID,
      title: "Taken",
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
