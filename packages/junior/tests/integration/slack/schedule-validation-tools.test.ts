import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SchedulerToolContext } from "@sentry/junior-scheduler";
import {
  PluginToolInputError,
  cleanupSlackScheduleToolTest,
  createContext,
  createSlackScheduleCreateTaskTool,
  createTask,
  executeTool,
  schedulerStore,
  setupSlackScheduleToolTest,
  TEST_TEAM_ID,
} from "../../fixtures/slack/schedule-tools";

describe("Slack schedule create validation", () => {
  beforeEach(setupSlackScheduleToolTest);
  afterEach(cleanupSlackScheduleToolTest);

  it("rejects invalid Slack workspace context before creating a task", async () => {
    const rejected = executeTool(
      createSlackScheduleCreateTaskTool(createContext({ teamId: "D123" })),
      {
        task: "Reminder: Remind David to wash his hands.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
      },
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "Active Slack conversation workspace is invalid.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects synthetic unknown requester ids before creating a task", async () => {
    const rejected = createTask(
      createContext({
        requester: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          userId: "unknown",
          userName: "unknown",
          fullName: "unknown",
        },
      }),
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "No active Slack requester context is available.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects source contexts with non-canonical fields", async () => {
    const rejected = createTask(
      createContext({
        source: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          channelId: "C123",
          threadTs: "1700000000.000",
        } as SchedulerToolContext["source"],
      }),
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "Active Slack conversation must not include unknown fields.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects non-canonical Slack channel ids before creating a task", async () => {
    const rejected = createTask(
      createContext({
        source: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          channelId: "slack:D123:1700000000.000",
        } as SchedulerToolContext["source"],
      }),
      {
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
        recurrence: undefined,
      },
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "Active Slack conversation channel is invalid.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects invalid Slack credential subject context before creating a task", async () => {
    const rejected = createTask(
      createContext({
        channelId: "D123",
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: TEST_TEAM_ID,
            channelId: "D123",
            signature: "v1=test",
          },
        } as SchedulerToolContext["credentialSubject"],
      }),
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "Active Slack credential subject is invalid.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects parseable non-ISO next run timestamps", async () => {
    await expect(
      createTask(createContext(), {
        next_run_at: "05/25/2026 09:00",
      }),
    ).rejects.toThrow("Provide next_run_at as a valid ISO timestamp.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects missing next run timestamps with a tool error", async () => {
    await expect(
      createTask(createContext(), {
        next_run_at: undefined,
      }),
    ).rejects.toThrow("Provide next_run_at as a valid ISO timestamp.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects recurring schedules that can run more than once per day", async () => {
    await expect(
      createTask(createContext(), {
        schedule: "Every hour",
        recurrence: "hourly",
      }),
    ).rejects.toThrow(
      "Recurring scheduled tasks can run at most once per day.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects invalid default timezones", async () => {
    process.env.JUNIOR_TIMEZONE = "not/a-zone";

    await expect(
      createTask(createContext(), {
        timezone: undefined,
      }),
    ).rejects.toThrow("timezone must be a valid IANA time zone.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });
});
