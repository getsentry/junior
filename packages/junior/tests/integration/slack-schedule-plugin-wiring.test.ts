import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schedulerPlugin } from "@sentry/junior-scheduler";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import {
  cleanupSlackScheduleToolTest,
  executeTool,
  schedulerStore,
  setupSlackScheduleToolTest,
} from "../fixtures/slack/schedule-tools";

describe("Slack schedule plugin wiring", () => {
  beforeEach(setupSlackScheduleToolTest);

  afterEach(async () => {
    setPlugins([]);
    await cleanupSlackScheduleToolTest();
  });

  it("binds scheduler tasks to the runtime-owned source", async () => {
    const previous = setPlugins([schedulerPlugin()]);
    try {
      const teamId = `TWIRING${Date.now()}`;
      const tools = getPluginTools({
        source: {
          platform: "slack",
          teamId,
          channelId: "DDM",
        },
        destination: {
          platform: "slack",
          teamId,
          channelId: "CASSISTANT",
        },
        requester: {
          platform: "slack",
          teamId,
          userId: "U123",
          userName: "alice",
          fullName: "Alice",
        },
        sandbox: {} as Parameters<typeof getPluginTools>[0]["sandbox"],
      });

      expect(tools).toHaveProperty("slackScheduleCreateTask");

      const result = await executeTool(tools.slackScheduleCreateTask, {
        task: "Wiring test: post a weekly digest.",
        schedule: "Every Monday at 9am",
        timezone: "America/Los_Angeles",
        next_run_at: "2026-06-09T16:00:00.000Z",
        recurrence: "weekly",
      });

      expect(result).toMatchObject({ ok: true });
      const taskId = (result as { task: { id: string } }).task.id;
      const stored = await schedulerStore().getTask(taskId);
      expect(stored).toMatchObject({
        destination: { channelId: "DDM", teamId },
        conversationAccess: { audience: "direct", visibility: "private" },
      });
      expect(stored?.credentialSubject).toMatchObject({
        type: "user",
        userId: "U123",
        allowedWhen: "private-direct-conversation",
      });
    } finally {
      setPlugins(previous);
    }
  });
});
