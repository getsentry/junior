import { describe, expect, it } from "vitest";
import { createTestThread } from "../../fixtures/slack-harness";

describe("slack harness fixture", () => {
  it("uses explicit channelId when provided", () => {
    const thread = createTestThread({ id: "thread-3", channelId: "C-3" });

    expect(thread.channelId).toBe("C-3");
    expect(thread.channel.id).toBe("C-3");
  });

  it("falls back to parsing channelId from slack thread id", () => {
    const thread = createTestThread({ id: "slack:C_TEST:1700000000.000" });

    expect(thread.channelId).toBe("C_TEST");
    expect(thread.channel.id).toBe("C_TEST");
  });

  it("keeps posts and postKinds aligned when deleting a duplicate post", async () => {
    const thread = createTestThread({ id: "slack:C_TEST:1700000000.000" });

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
