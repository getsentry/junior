import { describe, expect, it } from "vitest";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import {
  connectMcpTools,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { seedMcpAutomation } from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

describe("getAutomation MCP tool", () => {
  it("returns one Automation with its newest runs first", async () => {
    await seedMcpAutomation({
      email: MCP_TEST_VIEWER,
      id: "sched_viewer_digest",
      instruction: "Post the weekly issue digest.",
      slackUserId: "U123",
      title: "Weekly digest",
      visibility: "public",
    });
    const nowMs = Date.now();
    await recordAutomationExecution("sched_viewer_digest", {
      executionId: "run-1",
      nowMs: nowMs - 60_000,
    });
    await recordAutomationExecution("sched_viewer_digest", {
      errorMessage: "Dispatch failed.",
      executionId: "run-2",
      nowMs,
      status: "failed",
    });
    const call = await connectMcpTools();

    const result = await call("getAutomation", { id: "sched_viewer_digest" });

    expect(result.structuredContent).toEqual({
      automation: expect.objectContaining({
        id: "sched_viewer_digest",
        lastRunStatus: "failed",
        title: "Weekly digest",
      }),
      runs: [
        {
          error: "Dispatch failed.",
          executedAt: new Date(nowMs).toISOString(),
          status: "failed",
        },
        {
          executedAt: new Date(nowMs - 60_000).toISOString(),
          status: "completed",
        },
      ],
    });
  });

  it("reports a missing or hidden Automation as not found", async () => {
    // The viewer's own Automation gives them a Slack identity in the team.
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
      id: "sched_other_private",
      instruction: "This private Automation must stay hidden.",
      slackUserId: "U456",
      title: "Private check",
      visibility: "private",
    });
    const call = await connectMcpTools();

    const missing = await call("getAutomation", { id: "missing" });
    const hidden = await call("getAutomation", { id: "sched_other_private" });

    for (const result of [missing, hidden]) {
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Automation not found." }],
      });
    }
  });
});
