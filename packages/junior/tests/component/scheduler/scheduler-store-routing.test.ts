import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ScheduledTask } from "@sentry/junior-scheduler";
import { createSchedulerStore } from "../../../../junior-scheduler/src/store";
import { createPluginState } from "@/chat/plugins/state";
import { disconnectStateAdapter } from "@/chat/state/adapter";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched_valid",
    createdAtMs: Date.parse("2026-05-25T16:00:00.000Z"),
    createdBy: { slackUserId: "U123" },
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    },
    executionActor: {
      type: "system",
      id: "scheduled-task",
    },
    nextRunAtMs: Date.parse("2026-05-25T16:00:00.000Z"),
    schedule: {
      description: "Every Monday at 9am",
      kind: "one_off",
      timezone: "America/Los_Angeles",
    },
    status: "active",
    task: {
      text: "Summarize open scheduler issues.",
    },
    updatedAtMs: Date.parse("2026-05-25T16:00:00.000Z"),
    version: 1,
    ...overrides,
  };
}

describe("scheduler store routing", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("rejects invalid scheduled task routing context", async () => {
    const store = createSchedulerStore(createPluginState("scheduler"));

    await expect(
      store.saveTask(
        createTask({
          id: "sched_bad_destination",
          destination: {
            platform: "slack",
            teamId: "D_BAD_TEAM",
            channelId: "D123",
          },
        }),
      ),
    ).rejects.toThrow("Scheduled task routing context is invalid.");
    await expect(store.getTask("sched_bad_destination")).resolves.toBe(
      undefined,
    );

    await expect(
      store.saveTask(
        createTask({
          id: "sched_bad_credential_subject",
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "D123",
          },
          credentialSubject: {
            type: "user",
            userId: "U123",
            allowedWhen: "private-direct-conversation",
            binding: {
              type: "slack-direct-conversation",
              teamId: "T123",
              channelId: "D123",
              signature: "v1=test",
            },
          } as ScheduledTask["credentialSubject"],
        }),
      ),
    ).rejects.toThrow("Scheduled task routing context is invalid.");
    await expect(store.getTask("sched_bad_credential_subject")).resolves.toBe(
      undefined,
    );
  });
});
