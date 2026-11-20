import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import {
  seedMcpConversation,
  seedMcpReviewItem,
} from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

const CONVERSATION_ID = "slack:C123:1700000000.000500";

async function seedRelease() {
  await seedMcpConversation({
    conversationId: CONVERSATION_ID,
    email: MCP_TEST_VIEWER,
    title: "Release review",
  });
}

describe("searchReviewItems MCP tool", () => {
  it("returns only the open Review items that the viewer can see", async () => {
    await seedRelease();
    const mine = await seedMcpReviewItem({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Approve the release",
    });
    await seedMcpReviewItem({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Approve the budget",
    });
    const call = await connectMcpTools();

    const result = await call("searchReviewItems");

    expect(result.structuredContent).toEqual({
      items: [
        expect.objectContaining({
          id: mine.id,
          canAct: true,
          conversationIds: [CONVERSATION_ID],
          question: "Ship it?",
          status: "open",
          title: "Approve the release",
          url: expect.any(String),
        }),
      ],
      truncated: false,
    });
  });

  it("filters by text and marks a result cut by the limit", async () => {
    await seedRelease();
    for (const title of ["Approve the release", "Approve the budget"]) {
      await seedMcpReviewItem({
        conversationId: CONVERSATION_ID,
        email: MCP_TEST_VIEWER,
        title,
      });
    }
    const call = await connectMcpTools();

    const matched = await call("searchReviewItems", { q: "budget" });
    const limited = await call("searchReviewItems", { limit: 1 });

    expect(matched.structuredContent).toEqual({
      items: [expect.objectContaining({ title: "Approve the budget" })],
      truncated: false,
    });
    expect(limited.structuredContent).toEqual({
      items: [expect.any(Object)],
      truncated: true,
    });
  });
});
