import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createSlackScheduledTaskRunner } from "@/chat/scheduler/slack-runner";
import type { ScheduledRun, ScheduledTask } from "@/chat/scheduler/types";
import type { AssistantReply } from "@/chat/respond";
import { chatPostMessageOk } from "../fixtures/slack/factories/api";
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
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.000000",
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
        expect(context.requester).toMatchObject({
          userId: "U123",
          userName: "dcramer",
          fullName: "David Cramer",
        });
        expect(context.correlation).toMatchObject({
          channelId: "C123",
          teamId: "T123",
          threadTs: "1700000000.000000",
          runId: run.id,
        });
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
          thread_ts: "1700000000.000000",
          text: "Scheduled digest delivered.",
        }),
      }),
    ]);
  });
});
