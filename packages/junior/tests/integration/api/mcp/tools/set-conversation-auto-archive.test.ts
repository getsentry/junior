import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

const CONVERSATION_ID = "slack:C123:1700000000.000300";

describe("setConversationAutoArchive MCP tool", () => {
  it("sets the viewer's auto-archive choice for one Conversation", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    const call = await connectMcpTools();

    const on = await call("setConversationAutoArchive", {
      autoArchive: true,
      conversationId: CONVERSATION_ID,
    });
    const off = await call("setConversationAutoArchive", {
      autoArchive: false,
      conversationId: CONVERSATION_ID,
    });

    expect(on.structuredContent).toEqual({ autoArchive: true });
    expect(off.structuredContent).toEqual({ autoArchive: false });
  });

  it("reports another person's Conversation as not found", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const result = await call("setConversationAutoArchive", {
      autoArchive: true,
      conversationId: CONVERSATION_ID,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
