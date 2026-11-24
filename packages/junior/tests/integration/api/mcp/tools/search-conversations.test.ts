import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_ORIGIN,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../../fixtures/mcp-tools";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { getSqlExecutor } from "@/chat/db";

mockMcpDashboardConfig();

describe("searchConversations MCP tool", () => {
  it("returns only the Conversations that the viewer takes part in", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000100",
      email: MCP_TEST_VIEWER,
      title: "Viewer launch plan",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000200",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other person's roadmap",
    });
    const call = await connectMcpTools();

    const result = await call("searchConversations");

    expect(result).toEqual({
      content: [
        { type: "text", text: JSON.stringify(result.structuredContent) },
      ],
      structuredContent: {
        conversations: [
          {
            conversationId: "slack:C123:1700000000.000100",
            title: "Viewer launch plan",
            status: "done",
            turnActive: false,
            treeState: "done",
            watching: false,
            surface: "slack",
            startedAt: expect.any(String),
            lastSeenAt: expect.any(String),
            url: `${MCP_TEST_ORIGIN}/conversations/${encodeURIComponent("slack:C123:1700000000.000100")}`,
          },
        ],
      },
    });
  });

  it("matches the query against the viewer's Conversations only", async () => {
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000300",
      email: MCP_TEST_VIEWER,
      title: "Budget review",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000400",
      email: MCP_TEST_VIEWER,
      title: "Launch plan",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000500",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Budget forecast",
    });
    const call = await connectMcpTools();

    const result = await call("searchConversations", { q: "budget" });

    expect(result.structuredContent).toEqual({
      conversations: [
        expect.objectContaining({
          conversationId: "slack:C123:1700000000.000300",
        }),
      ],
    });
  });

  it("nests visible Threads only when asked", async () => {
    const rootId = "slack:C123:1700000000.000600";
    const otherRootId = "slack:C123:1700000000.000700";
    await seedMcpConversation({
      conversationId: rootId,
      email: MCP_TEST_VIEWER,
      title: "Deploy triage",
    });
    await seedMcpConversation({
      conversationId: otherRootId,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other person's triage",
    });
    const store = createSqlStore(getSqlExecutor());
    const child = (
      childConversationId: string,
      parentConversationId: string,
      kind: "task" | "thread",
      title: string,
    ) =>
      store.createChild({
        childConversationId,
        kind,
        parentConversationId,
        title,
      });
    await child("agent:thread", rootId, "thread", "Read the agent logs");
    await child("agent:nested", "agent:thread", "thread", "Recheck one log");
    await child("agent:task", rootId, "task", "Count failed runs");
    await child("agent:other", otherRootId, "thread", "Other person's Thread");
    const call = await connectMcpTools();

    const plain = await call("searchConversations");
    const nested = await call("searchConversations", { includeThreads: true });

    expect(plain.structuredContent).toEqual({
      conversations: [
        expect.not.objectContaining({ threads: expect.anything() }),
      ],
    });
    // Tasks never show, and a root's access decides its Threads.
    expect(nested.structuredContent).toEqual({
      conversations: [
        expect.objectContaining({
          conversationId: rootId,
          threads: [
            expect.objectContaining({
              conversationId: "agent:thread",
              title: "Read the agent logs",
              threads: [
                expect.objectContaining({
                  conversationId: "agent:nested",
                  title: "Recheck one log",
                }),
              ],
            }),
          ],
        }),
      ],
    });
  });
});
