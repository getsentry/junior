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

describe("pinConversation MCP tool", () => {
  it("pins a Conversation for the viewer and unpins it", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    const call = await connectMcpTools();

    const pinned = await call("pinConversation", {
      conversationId: CONVERSATION_ID,
    });
    const listed = await call("searchConversations");
    const unpinned = await call("pinConversation", {
      conversationId: CONVERSATION_ID,
      pinned: false,
    });

    const pinnedAt = (pinned.structuredContent as { pinnedAt: string })
      .pinnedAt;
    expect(pinnedAt).toEqual(expect.any(String));
    expect(listed.structuredContent).toEqual({
      conversations: [
        expect.objectContaining({ conversationId: CONVERSATION_ID, pinnedAt }),
      ],
    });
    expect(unpinned.structuredContent).toEqual({ pinnedAt: null });
  });

  it("reports another person's Conversation as not found", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const result = await call("pinConversation", {
      conversationId: CONVERSATION_ID,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
