import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import {
  seedMcpConversation,
  seedMcpInboxItem,
} from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

const CONVERSATION_ID = "slack:C123:1700000000.000500";

describe("getInboxItem MCP tool", () => {
  it("returns an Inbox item that the viewer can act on", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Release review",
    });
    const item = await seedMcpInboxItem({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Approve the release",
    });
    const call = await connectMcpTools();

    const result = await call("getInboxItem", { id: item.id });

    expect(result.structuredContent).toEqual({
      item: expect.objectContaining({
        id: item.id,
        body: "Pick one.",
        canAct: true,
        kind: "action",
        needsViewer: true,
        question: "Ship it?",
        title: "Approve the release",
      }),
    });
  });

  it("marks only open actions assigned to the viewer as waiting on them", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Release review",
    });
    const notice = await seedMcpInboxItem({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      kind: "notice",
      title: "Release review replied",
    });
    const forEveryone = await seedMcpInboxItem({
      assignedToEveryone: true,
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Approve the rollout",
    });
    const call = await connectMcpTools();

    const noticeResult = await call("getInboxItem", { id: notice.id });
    const everyoneResult = await call("getInboxItem", { id: forEveryone.id });

    expect(noticeResult.structuredContent).toEqual({
      item: expect.objectContaining({
        canAct: true,
        kind: "notice",
        needsViewer: false,
      }),
    });
    expect(everyoneResult.structuredContent).toEqual({
      item: expect.objectContaining({
        assignees: [],
        needsViewer: true,
      }),
    });
  });

  it("refuses another person's private Inbox item", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Budget review",
    });
    const item = await seedMcpInboxItem({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Approve the budget",
    });
    const call = await connectMcpTools();

    const result = await call("getInboxItem", { id: item.id });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain("Approve the budget");
  });
});
