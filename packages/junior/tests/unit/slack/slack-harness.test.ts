import { afterEach, describe, expect, it } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  createTestThread,
  FakeSlackAdapter,
} from "../../fixtures/slack-harness";

describe("slack harness fixture", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("identifies its fake adapter as Slack", () => {
    expect(new FakeSlackAdapter().name).toBe("slack");
  });

  it("uses explicit channelId when provided", async () => {
    const thread = await createTestThread({ id: "thread-3", channelId: "C-3" });

    expect(thread.channelId).toBe("C-3");
    expect(thread.channel.id).toBe("C-3");
  });

  it("falls back to parsing channelId from slack thread id", async () => {
    const thread = await createTestThread({ id: "slack:C0TEST:1700000000.000" });

    expect(thread.channelId).toBe("slack:C0TEST");
    expect(thread.channel.id).toBe("slack:C0TEST");
  });

  it("keeps posts and postKinds aligned when deleting a duplicate post", async () => {
    const thread = await createTestThread({ id: "slack:C0TEST:1700000000.000" });

    await thread.post(
      (async function* () {
        yield "same";
      })(),
    );
    const sent = await thread.post("same");

    await sent.delete();

    expect(thread.posts).toEqual(["same"]);
    expect(thread.postKinds).toEqual(["stream"]);
  });

  it("does not inherit leftover adapter scratch when reusing a thread id", async () => {
    const threadId = "slack:C0HARNESS:1700000000.000";
    const first = await createTestThread({
      id: threadId,
      state: {
        artifacts: { lastCanvasId: "Fstale" },
      },
    });
    await expect(first.getState()).resolves.toMatchObject({
      artifacts: { lastCanvasId: "Fstale" },
    });

    const second = await createTestThread({ id: threadId });
    await expect(second.getState()).resolves.toEqual({});
  });
});
