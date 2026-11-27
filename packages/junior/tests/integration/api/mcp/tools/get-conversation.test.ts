import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/chat/db";
import { recordAuthorizationRequested } from "@/chat/conversations/projection";
import { insertInboxItem } from "@/chat/inbox-items/store";
import { juniorConversations } from "@/db/schema";
import { storeConversationMetadataFixture } from "../../../../fixtures/conversation-metadata";
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

// A sign-in wait on someone who is not the viewer.
const SIGN_IN = {
  actorId: "UOTHER",
  authorizationId: "mcp-sign-in",
  conversationId: CONVERSATION_ID,
  delivery: "private_link_sent" as const,
  kind: "mcp" as const,
  provider: "notion",
};

describe("getConversation MCP tool", () => {
  it("returns the metadata, the summary, and only the last assistant reply", async () => {
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
    await storeConversationMetadataFixture(getDb(), {
      conversationId: CONVERSATION_ID,
      summary: "Relay was rolled back.",
    });
    const call = await connectMcpTools();

    const result = await call("getConversation", {
      conversationId: CONVERSATION_ID,
    });

    expect(result.structuredContent).toEqual({
      conversation: expect.objectContaining({
        conversationId: CONVERSATION_ID,
        summary: "Relay was rolled back.",
        title: "Viewer incident",
      }),
      lastReply: expect.objectContaining({
        messageId: "message-3",
        role: "assistant",
        text: "The rollback is done.",
      }),
      pendingMessages: [],
      cursor: expect.any(String),
    });
  });

  it("reports a running Turn apart from the status", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    const call = await connectMcpTools();
    const idle = await call("getConversation", {
      conversationId: CONVERSATION_ID,
    });
    await getDb()
      .update(juniorConversations)
      .set({ executionStatus: "running" })
      .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
    // A sign-in wait reads `needs_input` while the Turn runs.
    await recordAuthorizationRequested(SIGN_IN);

    const running = await call("getConversation", {
      conversationId: CONVERSATION_ID,
    });

    expect(idle.structuredContent).toMatchObject({
      conversation: { turnActive: false },
    });
    expect(running.structuredContent).toMatchObject({
      conversation: { status: "needs_input", turnActive: true },
    });
  });

  it("returns the viewer state apart from the status, and no Inbox state", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    // It waits on another person, so it does not need the viewer.
    await recordAuthorizationRequested(SIGN_IN);
    // An Inbox item is the Inbox's fact: `searchInboxItems` lists it.
    await insertInboxItem(getDb(), {
      subject: { id: "everyone-ask", kind: "question" },
      owner: { id: CONVERSATION_ID, kind: "conversation" },
      assignedToEveryone: true,
      assigneeUserIds: [],
      body: "Pick one.",
      conversationIds: [CONVERSATION_ID],
      kind: "action",
      nowMs: Date.now(),
      request: {
        question: "Ship now?",
        fields: [
          {
            id: "decision",
            kind: "choice",
            label: "Decision",
            options: [{ label: "Ship" }, { label: "Wait" }],
          },
        ],
      },
      title: "Ship the release?",
    });
    const call = await connectMcpTools();
    const detail = await call("getConversation", {
      conversationId: CONVERSATION_ID,
    });
    const list = await call("searchConversations");

    expect(detail.structuredContent).toMatchObject({
      conversation: {
        status: "needs_input",
        treeState: "done",
        watching: false,
      },
    });
    expect(list.structuredContent).toMatchObject({
      conversations: [{ conversationId: CONVERSATION_ID, treeState: "done" }],
    });
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
