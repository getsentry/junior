import { describe, expect, it } from "vitest";
import { getConversationStore } from "@/chat/db";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

const CONVERSATION_ID = "slack:C123:1700000000.000300";

function conversationIds(structuredContent: unknown): string[] {
  return (
    structuredContent as { conversations: { conversationId: string }[] }
  ).conversations.map((conversation) => conversation.conversationId);
}

describe("archiveConversation MCP tool", () => {
  it("archives a Conversation for the viewer and restores it", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    const call = await connectMcpTools();
    const lastSeenAt = (
      (await call("getConversation", { conversationId: CONVERSATION_ID }))
        .structuredContent as { conversation: { lastSeenAt: string } }
    ).conversation.lastSeenAt;

    const archived = await call("archiveConversation", {
      conversationId: CONVERSATION_ID,
      lastSeenAt,
    });
    const active = await call("searchConversations");
    const archivedList = await call("searchConversations", {
      status: "archived",
    });
    const restored = await call("archiveConversation", {
      archived: false,
      conversationId: CONVERSATION_ID,
      lastSeenAt,
    });

    expect(archived.structuredContent).toEqual({
      archivedAt: expect.any(String),
    });
    expect(conversationIds(active.structuredContent)).toEqual([]);
    expect(conversationIds(archivedList.structuredContent)).toEqual([
      CONVERSATION_ID,
    ]);
    expect(restored.structuredContent).toEqual({ archivedAt: null });
  });

  it("archives a Thread without archiving its root", async () => {
    const threadId = "agent:mcp-archive-thread";
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await getConversationStore().createChild({
      childConversationId: threadId,
      kind: "thread",
      parentConversationId: CONVERSATION_ID,
    });
    const call = await connectMcpTools();
    const readConversation = async (conversationId: string) =>
      (
        (await call("getConversation", { conversationId }))
          .structuredContent as {
          conversation: { archivedAt?: string; lastSeenAt: string };
        }
      ).conversation;

    const archived = await call("archiveConversation", {
      conversationId: threadId,
      lastSeenAt: (await readConversation(threadId)).lastSeenAt,
    });

    expect(archived.structuredContent).toEqual({
      archivedAt: expect.any(String),
    });
    expect((await readConversation(threadId)).archivedAt).toEqual(
      expect.any(String),
    );
    expect(
      (await readConversation(CONVERSATION_ID)).archivedAt,
    ).toBeUndefined();
  });

  it("refuses a stale lastSeenAt and another person's Conversation", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000400",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    const call = await connectMcpTools();

    const stale = await call("archiveConversation", {
      conversationId: CONVERSATION_ID,
      lastSeenAt: new Date(0).toISOString(),
    });
    const hidden = await call("archiveConversation", {
      conversationId: "slack:C123:1700000000.000400",
      lastSeenAt: new Date().toISOString(),
    });

    expect(stale).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation received new activity." }],
    });
    expect(hidden).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
