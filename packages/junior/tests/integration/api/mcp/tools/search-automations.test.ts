import { describe, expect, it } from "vitest";
import {
  connectMcpTools,
  MCP_TEST_ORIGIN,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpAutomation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

function automationIds(structuredContent: unknown): string[] {
  return (structuredContent as { automations: { id: string }[] }).automations
    .map((automation) => automation.id)
    .sort();
}

describe("searchAutomations MCP tool", () => {
  it("returns the viewer's and public Automations and filters them", async () => {
    await seedMcpAutomation({
      email: MCP_TEST_VIEWER,
      id: "sched_viewer_digest",
      instruction: "Post the weekly issue digest.",
      slackUserId: "U123",
      title: "Weekly digest",
      visibility: "public",
    });
    await seedMcpAutomation({
      email: MCP_TEST_OTHER_VIEWER,
      id: "sched_other_incidents",
      instruction: "Summarize open incidents.",
      slackUserId: "U456",
      title: "Incident summary",
      visibility: "public",
    });
    await seedMcpAutomation({
      email: MCP_TEST_OTHER_VIEWER,
      id: "sched_other_private",
      instruction: "This private Automation must stay hidden.",
      slackUserId: "U456",
      title: "Private check",
      visibility: "private",
    });
    const call = await connectMcpTools();

    const all = await call("searchAutomations");
    const mine = await call("searchAutomations", { scope: "mine" });
    const matched = await call("searchAutomations", { q: "incidents" });

    expect(automationIds(all.structuredContent)).toEqual([
      "sched_other_incidents",
      "sched_viewer_digest",
    ]);
    expect(all.structuredContent).toMatchObject({ total: 2 });
    expect(mine.structuredContent).toEqual({
      automations: [
        expect.objectContaining({
          id: "sched_viewer_digest",
          kind: "scheduled",
          instruction: "Post the weekly issue digest.",
          ownedByYou: true,
          status: "active",
          title: "Weekly digest",
          url: `${MCP_TEST_ORIGIN}/automations/sched_viewer_digest`,
        }),
      ],
      total: 1,
    });
    expect(automationIds(matched.structuredContent)).toEqual([
      "sched_other_incidents",
    ]);
  });
});
