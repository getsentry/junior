import { afterEach, describe, expect, it } from "vitest";
import { Message } from "chat";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  createTestMessage,
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

  it("creates a Chat SDK message with typed Slack data", () => {
    const dateSent = new Date("2026-08-11T12:00:00.000Z");
    const message = createTestMessage({
      id: "message-1",
      threadId: "slack:C0TEST:1700000000.000",
      text: "hello",
      dateSent,
      raw: {
        channel: "C0TEST",
        ts: "1700000000.100",
        thread_ts: "1700000000.000",
      },
    });

    expect(message).toBeInstanceOf(Message);
    expect(message.toJSON()).toMatchObject({
      _type: "chat:Message",
      id: "message-1",
      metadata: { dateSent: dateSent.toISOString(), edited: false },
      raw: {
        channel: "C0TEST",
        ts: "1700000000.100",
        thread_ts: "1700000000.000",
      },
      text: "hello",
      threadId: "slack:C0TEST:1700000000.000",
    });
  });

  it("uses explicit channelId when provided", async () => {
    const thread = await createTestThread({ id: "thread-3", channelId: "C-3" });

    expect(thread.adapter.name).toBe("test");
    expect(thread.channelId).toBe("C-3");
    expect(thread.channel.id).toBe("C-3");
  });

  it("falls back to parsing channelId from slack thread id", async () => {
    const thread = await createTestThread({
      id: "slack:C0TEST:1700000000.000",
    });

    expect(thread.channelId).toBe("slack:C0TEST");
    expect(thread.channel.id).toBe("slack:C0TEST");
  });

  it("keeps posts and postKinds aligned when deleting a duplicate post", async () => {
    const thread = await createTestThread({
      id: "slack:C0TEST:1700000000.000",
    });

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

  it("keeps a sent message and recorded post aligned after an edit", async () => {
    const thread = await createTestThread({
      id: "slack:C0TEST:1700000000.000",
    });
    const sent = await thread.post("before");

    const edited = await sent.edit("after");

    expect(edited).toBe(sent);
    expect(sent.text).toBe("after");
    expect(thread.posts).toEqual(["after"]);
    expect(thread.postKinds).toEqual(["value"]);
  });

  it("does not inherit leftover adapter scratch when reusing a thread id", async () => {
    const threadId = "slack:C0HARNESS:1700000000.000";
    const first = await createTestThread({
      id: threadId,
      state: {},
    });
    await expect(first.getState()).resolves.toMatchObject({});

    const second = await createTestThread({ id: threadId });
    await expect(second.getState()).resolves.toEqual({});
  });

  it("preserves adapter channel config when another thread joins the same channel", async () => {
    const channelId = "C0SHARED";
    const first = await createTestThread({
      id: "slack:C0SHARED:1700000000.000",
      channelId,
    });
    await first.channel.setState({
      configuration: {
        entries: {
          "github.repo": {
            key: "github.repo",
            value: "getsentry/junior",
          },
        },
      },
    });

    const second = await createTestThread({
      id: "slack:C0SHARED:1700000001.000",
      channelId,
    });
    await expect(second.channel.state).resolves.toMatchObject({
      configuration: {
        entries: {
          "github.repo": {
            key: "github.repo",
            value: "getsentry/junior",
          },
        },
      },
    });
  });
});
