import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchEventPromptRuns } from "@/chat/events/dispatch";
import { loadEventPromptRegistry } from "@/chat/events/registry";
import type {
  DispatchCreateResult,
  DispatchOptions,
} from "@/chat/agent-dispatch/types";

async function writeEventBinding(root: string): Promise<void> {
  const eventsDir = path.join(root, "app", "events", "slack");
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(
    path.join(eventsDir, "root-channel.md"),
    [
      "---",
      "id: slack-root-channel",
      "event: slack.channel.message.created",
      "scope:",
      "  channelId: C123",
      "context:",
      "  include:",
      "    - source_message",
      "---",
      "",
      "Review the Slack channel message and decide whether action is needed.",
      "",
    ].join("\n"),
  );
}

function createDispatchResult(): DispatchCreateResult {
  return {
    status: "created",
    record: {
      actor: { type: "system", id: "event-prompts" },
      attempt: 0,
      createdAtMs: 1700000000000,
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      id: "dispatch_event_1",
      idempotencyKey: "event:slack-root-channel:Ev123",
      input: "compiled prompt",
      maxAttempts: 5,
      plugin: "event-prompts",
      runMode: "event_prompt",
      status: "pending",
      updatedAtMs: 1700000000000,
      version: 1,
    },
  };
}

describe("event prompt dispatch", () => {
  afterEach(async () => {
    const emptyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-events-empty-"),
    );
    await loadEventPromptRegistry(emptyRoot);
  });

  it("creates a Slack dispatch for matching event bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-events-"));
    await writeEventBinding(root);
    await loadEventPromptRegistry(root);
    const dispatchInputs: Array<{
      nowMs: number;
      options: DispatchOptions;
      plugin: string;
    }> = [];
    const createDispatch = vi.fn(
      async (input: (typeof dispatchInputs)[number]) => {
        dispatchInputs.push(input);
        return createDispatchResult();
      },
    );
    const scheduleCallback = vi.fn(async () => undefined);

    const results = await dispatchEventPromptRuns(
      {
        event: "slack.channel.message.created",
        sourceEventId: "Ev123",
        occurredAtMs: 1700000000000,
        actor: { id: "U123", type: "slack_user" },
        scope: { teamId: "T123", channelId: "C123" },
        payload: {
          actor: "U123",
          teamId: "T123",
          channelId: "C123",
          messageTs: "1700000000.000001",
          userId: "U123",
          text: "deploy started",
        },
      },
      {
        createDispatch,
        scheduleCallback,
        nowMs: () => 1700000000000,
      },
    );

    expect(results).toHaveLength(1);
    expect(createDispatch).toHaveBeenCalledWith({
      plugin: "event-prompts",
      runMode: "event_prompt",
      nowMs: 1700000000000,
      options: expect.objectContaining({
        idempotencyKey: "event:slack-root-channel:Ev123",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        metadata: {
          bindingId: "slack-root-channel",
          eventId: "slack.channel.message.created",
          sourceEventId: "Ev123",
        },
      }),
    });
    const firstInput = dispatchInputs[0];
    if (!firstInput) {
      throw new Error("expected dispatch creation call");
    }
    const input = firstInput.options.input;
    expect(input).toContain("deploy started");
    expect(input).toContain("channel_id: C123");
    expect(input).toContain("Review the Slack channel message");
    expect(scheduleCallback).toHaveBeenCalledWith({
      id: "dispatch_event_1",
      expectedVersion: 1,
    });
  });
});
