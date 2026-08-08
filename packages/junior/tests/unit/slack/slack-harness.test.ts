import { describe, expect, it } from "vitest";
import {
  createTestThread,
  FakeSlackAdapter,
} from "../../fixtures/slack-harness";

describe("slack harness fixture", () => {
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
});
