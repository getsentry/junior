import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSlackScheduleToolTest,
  createContext,
  createSlackScheduleCreateTaskTool,
  createSlackScheduleListTasksTool,
  createTask,
  executeTool,
  schedulerStore,
  setupSlackScheduleToolTest,
  TEST_TEAM_ID,
} from "../fixtures/slack-schedule-tools";

describe("Slack schedule create tools", () => {
  beforeEach(setupSlackScheduleToolTest);
  afterEach(cleanupSlackScheduleToolTest);

  it("creates and lists tasks only for the active Slack destination", async () => {
    const created = await createTask();
    expect(created).toMatchObject({
      ok: true,
      task: {
        conversation_access: {
          audience: "channel",
          visibility: "unknown",
        },
        credential_subject: null,
        status: "active",
        task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
        recurrence: {
          frequency: "weekly",
          interval: 1,
          weekdays: [1],
        },
        next_run_at: "2026-05-25T16:00:00.000Z",
      },
    });

    const listed = await executeTool(
      createSlackScheduleListTasksTool(createContext()),
      {},
    );
    expect(listed).toMatchObject({
      ok: true,
      tasks: [
        {
          task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
          schedule: "Every Monday at 9am",
        },
      ],
    });

    const otherChannel = await executeTool(
      createSlackScheduleListTasksTool(createContext({ channelId: "C999" })),
      {},
    );
    expect(otherChannel).toMatchObject({
      ok: true,
      tasks: [],
    });
  });

  it("creates clear recurring tasks without a second confirmation", async () => {
    const result = await executeTool(
      createSlackScheduleCreateTaskTool(createContext()),
      {
        task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
        schedule: "Every Monday at 9am",
        timezone: "America/Los_Angeles",
        next_run_at: "2026-05-25T16:00:00.000Z",
        recurrence: "weekly",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        schedule: "Every Monday at 9am",
        status: "active",
        task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "C123" },
        status: "active",
      },
    ]);
  });

  it("does not store Slack ids as creator display identity", async () => {
    const created = (await createTask(
      createContext({
        requester: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          userId: "U039RR91S",
          userName: "unknown",
          fullName: "W039RR91S",
        },
      }),
    )) as { task: { id: string } };

    await expect(schedulerStore().getTask(created.task.id)).resolves.toEqual(
      expect.objectContaining({
        createdBy: {
          slackUserId: "U039RR91S",
        },
      }),
    );
  });

  it("creates explicit one-off reminders without a second confirmation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:24:23.000Z"));

    const result = await executeTool(
      createSlackScheduleCreateTaskTool(
        createContext({
          channelId: "D123",
          userText: "remind me in 1 minute to wash my hands",
        }),
      ),
      {
        task: "Wash hands reminder: Remind David to wash his hands.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-27T00:25:23.000Z",
        schedule: "In 1 minute",
        status: "active",
        task: "Wash hands reminder: Remind David to wash his hands.",
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        conversationAccess: {
          audience: "direct",
          visibility: "private",
        },
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
        },
        destination: { channelId: "D123" },
        nextRunAtMs: Date.parse("2026-05-27T00:25:23.000Z"),
        status: "active",
      },
    ]);
  });

  it("creates short imperative one-off reminders without channel confirmation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:24:23.000Z"));

    const result = await executeTool(
      createSlackScheduleCreateTaskTool(
        createContext({
          userText: "drink water in 1 minute in this conversation",
        }),
      ),
      {
        task: "Drink water reminder: Remind David to drink water.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-27T00:25:23.000Z",
        schedule: "In 1 minute",
        status: "active",
        task: "Drink water reminder: Remind David to drink water.",
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "C123" },
        nextRunAtMs: Date.parse("2026-05-27T00:25:23.000Z"),
        status: "active",
      },
    ]);
  });

  it("creates one-off reminders by omitting recurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T02:17:48.005Z"));

    const result = await executeTool(
      createSlackScheduleCreateTaskTool(
        createContext({
          userText: "remind greg to drink water in 1m",
        }),
      ),
      {
        task: "Remind Greg to drink water.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-28T02:18:48.005Z",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-28T02:18:48.005Z",
        recurrence: null,
        schedule: "In 1 minute",
        status: "active",
        task: "Remind Greg to drink water.",
      },
    });
    const [stored] = await schedulerStore().listTasksForTeam(TEST_TEAM_ID);
    expect(stored).toMatchObject({
      nextRunAtMs: Date.parse("2026-05-28T02:18:48.005Z"),
      schedule: {
        kind: "one_off",
      },
      status: "active",
    });
    expect(stored?.schedule.recurrence).toBeUndefined();
  });

  it("does not delegate user credentials in private group conversations", async () => {
    const result = await createTask(createContext({ channelId: "G123" }));

    expect(result).toMatchObject({
      ok: true,
      task: {
        conversation_access: {
          audience: "group",
          visibility: "private",
        },
        credential_subject: null,
      },
    });
    const tasks = await schedulerStore().listTasksForTeam(TEST_TEAM_ID);
    expect(tasks).toMatchObject([
      {
        conversationAccess: {
          audience: "group",
          visibility: "private",
        },
        destination: { channelId: "G123" },
      },
    ]);
    expect(tasks[0]?.credentialSubject).toBeUndefined();
  });

  it("creates one-off tasks with an exact timestamp using the default Pacific timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    const created = await createTask(createContext(), {
      schedule: "On May 26 at 9am",
      next_run_at: "2026-05-26T16:00:00.000Z",
      recurrence: undefined,
      timezone: undefined,
    });

    expect(created).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-26T16:00:00.000Z",
        recurrence: null,
        timezone: "America/Los_Angeles",
      },
    });
  });

  it("uses JUNIOR_TIMEZONE as the default schedule timezone", async () => {
    process.env.JUNIOR_TIMEZONE = "America/New_York";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    const created = await createTask(createContext(), {
      schedule: "On May 26 at 9am",
      next_run_at: "2026-05-26T13:00:00.000Z",
      recurrence: undefined,
      timezone: undefined,
    });

    expect(created).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-26T13:00:00.000Z",
        recurrence: null,
        timezone: "America/New_York",
      },
    });
  });
});
