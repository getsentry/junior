import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import {
  appendMcpMessages,
  seedMcpConversation,
} from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

const CONVERSATION_ID = "slack:C123:1700000000.000300";

describe("markConversationRead MCP tool", () => {
  it("marks every message read and does not move back", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await appendMcpMessages(CONVERSATION_ID, [
      { role: "user", text: "What broke?" },
      { role: "assistant", text: "The relay deploy broke ingestion." },
    ]);
    const call = await connectMcpTools();
    const { messages } = (
      await call("listConversationMessages", {
        conversationId: CONVERSATION_ID,
      })
    ).structuredContent as { messages: { seq: number }[] };

    const all = await call("markConversationRead", {
      conversationId: CONVERSATION_ID,
    });
    const older = await call("markConversationRead", {
      conversationId: CONVERSATION_ID,
      lastReadSeq: messages[0]!.seq,
    });

    expect(all.structuredContent).toEqual({
      lastReadSeq: messages.at(-1)!.seq,
    });
    expect(older.structuredContent).toEqual(all.structuredContent);
  });

  it("reports another person's Conversation as not found", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const result = await call("markConversationRead", {
      conversationId: CONVERSATION_ID,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
