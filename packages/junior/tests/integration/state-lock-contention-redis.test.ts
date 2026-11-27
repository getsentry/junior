import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  getDispatchRecord,
  markDispatchRunning,
} from "@/chat/agent-dispatch/store";
import {
  createTimerWatch,
  createWatch,
  listWatches,
} from "@/chat/events/store";
import { createPluginState } from "@/chat/plugins/state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createAgentDispatchTestRecord } from "../fixtures/agent-dispatch";

// Chat config reads the state adapter when it loads, so set it first. CI
// runs Redis at REDIS_URL. Locally, compose.yaml runs it on port 6382.
const previousEnv = vi.hoisted(() => {
  const previous = {
    JUNIOR_STATE_ADAPTER: process.env["JUNIOR_STATE_ADAPTER"],
    REDIS_URL: process.env["REDIS_URL"],
    JUNIOR_STATE_KEY_PREFIX: process.env["JUNIOR_STATE_KEY_PREFIX"],
  };
  process.env["JUNIOR_STATE_ADAPTER"] = "redis";
  process.env["REDIS_URL"] =
    process.env["REDIS_URL"]?.trim() || "redis://localhost:6382";
  process.env["JUNIOR_STATE_KEY_PREFIX"] = `junior_test_${crypto.randomUUID()}`;
  return previous;
});

// Later files in the same worker must not run on this file's Redis state.
afterAll(async () => {
  try {
    await disconnectStateAdapter();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe("Redis lock contention", () => {
  it("creates Watches and a timer in parallel in one Conversation", async () => {
    const conversationId = `conversation-${randomUUID()}`;
    const expiresAtMs = Date.now() + 60 * 60 * 1000;

    // One agent step can call watchEvents and watchTimer at the same time.
    await Promise.all([
      ...Array.from({ length: 6 }, (_, index) =>
        createWatch({
          conversationId,
          events: ["pull_request.merged"],
          expiresAtMs,
          identifier: `getsentry/junior#${index}`,
          intent: "Report the merge.",
          label: `getsentry/junior#${index}`,
          namespace: "github",
          resourceType: "pull_request",
        }),
      ),
      createTimerWatch({
        afterMs: 60_000,
        conversationId,
        intent: "Check back.",
        toolCallId: "tool-timer",
      }),
    ]);

    await expect(listWatches({ conversationId })).resolves.toHaveLength(7);
  });

  it("applies parallel dispatch transitions", async () => {
    const dispatch = await createAgentDispatchTestRecord(
      `lock-contention-${randomUUID()}`,
    );

    // Duplicate Conversation work deliveries mark the same dispatch running.
    await Promise.all(
      Array.from({ length: 6 }, () => markDispatchRunning(dispatch.id)),
    );

    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "running",
    });
  });

  it("reports a held plugin state lock as not acquired", async () => {
    const state = createPluginState("briefs");
    const key = `brief:${randomUUID()}`;
    let entered!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = state.withLock(key, 60_000, async () => {
      entered();
      await released;
      return "first";
    });
    await holding;

    await expect(
      state.withLock(key, 60_000, async () => "second"),
    ).resolves.toEqual({ acquired: false });

    release();
    await expect(first).resolves.toEqual({ acquired: true, value: "first" });
    await expect(
      state.withLock(key, 60_000, async () => "third"),
    ).resolves.toEqual({ acquired: true, value: "third" });
  });
});
