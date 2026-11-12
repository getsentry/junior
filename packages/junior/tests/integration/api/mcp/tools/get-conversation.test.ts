import { describe, expect, it } from "vitest";
import { appendConversationBrief } from "@/chat/briefs/store";
import { getDb } from "@/chat/db";
import { conversationBriefFixture } from "../../../../fixtures/conversation-brief";
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

describe("getConversation MCP tool", () => {
  it("returns the metadata, the Brief, and only the last assistant reply", async () => {
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
    await appendConversationBrief(getDb(), {
      content: conversationBriefFixture({ summary: "Relay was rolled back." }),
      conversationId: CONVERSATION_ID,
      modelId: "test-model",
      searchText: "relay rollback",
      throughSeq: 0,
      turnId: "brief-turn",
    });
    const call = await connectMcpTools();

    const result = await call("getConversation", {
      conversationId: CONVERSATION_ID,
    });

    expect(result.structuredContent).toEqual({
      conversation: expect.objectContaining({
        conversationId: CONVERSATION_ID,
        title: "Viewer incident",
      }),
      brief: expect.objectContaining({
        summary: "Relay was rolled back.",
        updatedAt: expect.any(String),
      }),
      lastReply: expect.objectContaining({
        messageId: "message-3",
        role: "assistant",
        text: "The rollback is done.",
      }),
      pendingMessages: [],
      cursor: expect.any(String),
    });
    expect(result.structuredContent).not.toHaveProperty("brief.record");
  });

  it("returns the messages after a cursor and a cursor to continue from", async () => {
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
    const { cursor } = (
      await call("getConversation", { conversationId: CONVERSATION_ID })
    ).structuredContent as { cursor: string };
    await appendMcpMessages(CONVERSATION_ID, [
      { role: "user", text: "Roll it back." },
      { role: "assistant", text: "The rollback is done." },
    ]);

    const newer = await call("getConversation", {
      conversationId: CONVERSATION_ID,
      after: cursor,
    });
    const next = (newer.structuredContent as { cursor: string }).cursor;
    const caughtUp = await call("getConversation", {
      conversationId: CONVERSATION_ID,
      after: next,
    });
    const invalid = await call("getConversation", {
      conversationId: CONVERSATION_ID,
      after: "not-a-cursor",
    });

    expect(newer.structuredContent).toMatchObject({
      messages: [
        { role: "user", text: "Roll it back." },
        { role: "assistant", text: "The rollback is done." },
      ],
    });
    expect(newer.structuredContent).not.toHaveProperty("lastReply");
    expect(caughtUp.structuredContent).toMatchObject({
      cursor: next,
      messages: [],
    });
    expect(invalid).toMatchObject({ isError: true });
  });

  it("reports another person's Conversation as not found", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const result = await call("getConversation", {
      conversationId: CONVERSATION_ID,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
