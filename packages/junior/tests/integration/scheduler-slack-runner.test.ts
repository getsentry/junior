import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createSlackScheduledTaskRunner } from "@/chat/scheduler/slack-runner";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import type { ScheduledRun, ScheduledTask } from "@/chat/scheduler/types";
import type { AssistantReply } from "@/chat/respond";
import {
  chatPostEphemeralOk,
  chatPostMessageOk,
  filesCompleteUploadOk,
  filesGetUploadUrlOk,
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

function createTask(): ScheduledTask {
  const scheduledForMs = Date.parse("2026-03-02T17:00:00.000Z");
  return {
    id: "sched_slack_runner",
    createdAtMs: scheduledForMs,
    updatedAtMs: scheduledForMs,
    createdBy: {
      slackUserId: "U123",
      userName: "dcramer",
      fullName: "David Cramer",
    },
    executionActor: {
      type: "system",
      id: "scheduled-task",
    },
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    nextRunAtMs: scheduledForMs,
    schedule: {
      description: "Every Monday at 9am Pacific",
      timezone: "America/Los_Angeles",
      kind: "recurring",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        startDate: "2026-03-02",
        time: {
          hour: 9,
          minute: 0,
        },
        weekdays: [1],
      },
    },
    status: "active",
    task: {
      title: "Issue digest",
      objective: "Summarize scheduler issues.",
      instructions: ["Find open scheduler issues", "Post a concise digest"],
    },
    version: 1,
  };
}

function createRun(task: ScheduledTask): ScheduledRun {
  const scheduledForMs = task.nextRunAtMs!;
  return {
    id: `${task.id}:${scheduledForMs}`,
    attempt: 1,
    claimedAtMs: scheduledForMs,
    idempotencyKey: `${task.id}:${scheduledForMs}`,
    scheduledForMs,
    status: "running",
    startedAtMs: scheduledForMs,
    taskId: task.id,
    taskVersion: task.version,
  };
}

function createReply(): AssistantReply {
  return {
    text: "Scheduled digest delivered.",
    deliveryMode: "thread",
    deliveryPlan: {
      mode: "thread",
      postThreadText: true,
      attachFiles: "none",
    },
    diagnostics: {
      assistantMessageCount: 1,
      durationMs: 1234,
      modelId: "test-model",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
  };
}

describe("scheduled Slack runner", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("delivers scheduled run output through Slack Web API", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000001",
      }),
    });
    const task = createTask();
    const run = createRun(task);
    const runner = createSlackScheduledTaskRunner({
      generateAssistantReply: async (_prompt, context) => {
        if (!context) {
          throw new Error("expected reply context");
        }
        expect(context.requester).toBeUndefined();
        expect(context.correlation).toMatchObject({
          channelId: "C123",
          teamId: "T123",
          runId: run.id,
          actorType: "system",
          actorId: "scheduled-task",
        });
        expect(context.correlation?.requesterId).toBeUndefined();
        return createReply();
      },
    });

    const result = await runner.run({
      task,
      run,
      prompt: "<scheduled-task-run />",
      nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
    });

    expect(result).toEqual({
      status: "completed",
      resultMessageTs: "1700000000.000001",
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: "Scheduled digest delivered.",
        }),
      }),
    ]);
  });

  it("does not post again when a scheduled run already has a delivered result", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000001",
      }),
    });
    const task = createTask();
    const run = createRun(task);
    const generateAssistantReply = vi.fn(async () => createReply());
    const runner = createSlackScheduledTaskRunner({ generateAssistantReply });

    await expect(
      runner.run({
        task,
        run,
        prompt: "<scheduled-task-run />",
        nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
      }),
    ).resolves.toEqual({
      status: "completed",
      resultMessageTs: "1700000000.000001",
    });
    await expect(
      runner.run({
        task,
        run,
        prompt: "<scheduled-task-run />",
        nowMs: Date.parse("2026-03-02T17:00:02.000Z"),
      }),
    ).resolves.toEqual({
      status: "completed",
      resultMessageTs: "1700000000.000001",
    });

    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
  });

  it("isolates scheduled conversation state by Slack workspace", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000001",
      }),
    });
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000002",
      }),
    });
    const firstTask = createTask();
    const baseSecondTask = createTask();
    const secondTask = {
      ...baseSecondTask,
      id: "sched_slack_runner_other_team",
      destination: {
        ...baseSecondTask.destination,
        teamId: "T999",
      },
    };
    const runner = createSlackScheduledTaskRunner({
      generateAssistantReply: async () => createReply(),
    });

    await runner.run({
      task: firstTask,
      run: createRun(firstTask),
      prompt: "<scheduled-task-run />",
      nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
    });
    await runner.run({
      task: secondTask,
      run: createRun(secondTask),
      prompt: "<scheduled-task-run />",
      nowMs: Date.parse("2026-03-02T17:00:02.000Z"),
    });

    await expect(
      getPersistedThreadState("slack:T123:C123"),
    ).resolves.toMatchObject({
      conversation: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: `scheduled-run:${createRun(firstTask).id}:user`,
            author: expect.objectContaining({
              userName: "system:scheduled-task",
              isBot: true,
            }),
          }),
          expect.objectContaining({
            id: `scheduled-run:${createRun(firstTask).id}:assistant`,
          }),
        ]),
      },
    });
    await expect(
      getPersistedThreadState("slack:T999:C123"),
    ).resolves.toMatchObject({
      conversation: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: `scheduled-run:${createRun(secondTask).id}:assistant`,
          }),
        ]),
      },
    });
  });

  it("posts file-only scheduled results under a top-level message", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000010",
      }),
    });
    queueSlackApiResponse("files.getUploadURLExternal", {
      body: filesGetUploadUrlOk({
        fileId: "F_SCHEDULED",
        uploadUrl: "https://files.slack.com/upload/v1/F_SCHEDULED",
      }),
    });
    queueSlackApiResponse("files.completeUploadExternal", {
      body: filesCompleteUploadOk({
        files: [{ id: "F_SCHEDULED" }],
      }),
    });
    const task = createTask();
    const run = createRun(task);
    const runner = createSlackScheduledTaskRunner({
      generateAssistantReply: async () => ({
        ...createReply(),
        text: "",
        deliveryPlan: {
          mode: "thread",
          postThreadText: true,
          attachFiles: "inline",
        },
        files: [
          {
            data: Buffer.from("scheduled report"),
            filename: "report.txt",
          },
        ],
      }),
    });

    await expect(
      runner.run({
        task,
        run,
        prompt: "<scheduled-task-run />",
        nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
      }),
    ).resolves.toEqual({
      status: "completed",
      resultMessageTs: "1700000000.000010",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: "Generated files are attached.",
        }),
      }),
    ]);
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.000010",
    });
  });

  it("blocks scheduled runs instead of starting authorization", async () => {
    queueSlackApiResponse("chat.postEphemeral", {
      body: chatPostEphemeralOk(),
    });
    const task = createTask();
    const run = createRun(task);
    const runner = createSlackScheduledTaskRunner({
      generateAssistantReply: async (_prompt, context) => {
        if (!context) {
          throw new Error("expected reply context");
        }
        expect(context.authorizationFlowMode).toBe("disabled");
        expect(context.pendingAuth).toBeUndefined();
        expect(context.onAuthPending).toBeUndefined();
        throw new AuthorizationFlowDisabledError("mcp", "github");
      },
    });

    const result = await runner.run({
      task,
      run,
      prompt: "<scheduled-task-run />",
      nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
    });

    expect(result).toEqual({
      status: "blocked",
      errorMessage:
        "Scheduled task requires github authorization. Connect github in an interactive Slack message, then resume the task.",
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          text: expect.stringContaining(
            'Scheduled task "Issue digest" is blocked',
          ),
        }),
      }),
    ]);
    await expect(
      getPersistedThreadState("slack:T123:C123"),
    ).resolves.not.toMatchObject({
      conversation: { processing: { pendingAuth: expect.anything() } },
    });
  });

  it("privately blocks scheduled runs on provider credential failures", async () => {
    queueSlackApiResponse("chat.postEphemeral", {
      body: chatPostEphemeralOk(),
    });
    const task = createTask();
    const run = createRun(task);
    const runner = createSlackScheduledTaskRunner({
      generateAssistantReply: async () => {
        throw new PluginCredentialFailureError(
          "github",
          "GitHub credentials were rejected while running `gh auth status`. Verify the GitHub App installation covers the target repository and the host GitHub App environment variables are current.",
        );
      },
    });

    await expect(
      runner.run({
        task,
        run,
        prompt: "<scheduled-task-run />",
        nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      errorMessage: expect.stringContaining("GitHub credentials were rejected"),
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          text: expect.stringContaining("GitHub credentials were rejected"),
        }),
      }),
    ]);
  });
});
