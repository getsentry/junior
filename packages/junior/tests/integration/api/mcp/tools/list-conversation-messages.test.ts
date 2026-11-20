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
const OTHER_CONVERSATION_ID = "slack:C123:1700000000.000400";

describe("listConversationMessages MCP tool", () => {
  it("pages back from the newest message with a cursor", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await appendMcpMessages(CONVERSATION_ID, [
      { role: "user", text: "What broke?" },
      { role: "assistant", text: "The relay deploy broke ingestion." },
      { role: "user", text: "Roll it back." },
      { role: "assistant", text: "The rollback is done." },
    ]);
    const call = await connectMcpTools();

    const newest = await call("listConversationMessages", {
      conversationId: CONVERSATION_ID,
      limit: 3,
    });
    const older = await call("listConversationMessages", {
      before: (newest.structuredContent as { nextCursor: string }).nextCursor,
      conversationId: CONVERSATION_ID,
    });

    expect(newest.structuredContent).toEqual({
      messages: [
        expect.objectContaining({ text: "The relay deploy broke ingestion." }),
        expect.objectContaining({ text: "Roll it back." }),
        expect.objectContaining({ text: "The rollback is done." }),
      ],
      nextCursor: expect.any(String),
    });
    expect(older.structuredContent).toEqual({
      messages: [
        expect.objectContaining({ role: "user", text: "What broke?" }),
      ],
    });
  });

  it("rejects a cursor from another Conversation and hides other Conversations", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await seedMcpConversation({
      conversationId: OTHER_CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    await appendMcpMessages(CONVERSATION_ID, [
      { role: "user", text: "First." },
      { role: "assistant", text: "Second." },
    ]);
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000500",
      email: MCP_TEST_VIEWER,
      title: "Second viewer incident",
    });
    await appendMcpMessages("slack:C123:1700000000.000500", [
      { role: "user", text: "Third." },
      { role: "assistant", text: "Fourth." },
    ]);
    const call = await connectMcpTools();
    const page = await call("listConversationMessages", {
      conversationId: "slack:C123:1700000000.000500",
      limit: 1,
    });

    const wrongCursor = await call("listConversationMessages", {
      before: (page.structuredContent as { nextCursor: string }).nextCursor,
      conversationId: CONVERSATION_ID,
    });
    const hidden = await call("listConversationMessages", {
      conversationId: OTHER_CONVERSATION_ID,
    });

    expect(wrongCursor).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "The cursor is not valid. Omit `before` to read the newest messages.",
        },
      ],
    });
    expect(hidden).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
