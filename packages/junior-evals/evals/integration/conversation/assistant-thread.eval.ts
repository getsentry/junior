import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { test } from "@junior-evals/fixture/test";

describe("Slack Thread Status and Title", () => {
  test("when a channel mention starts a turn, Junior shows a status and clears it after the reply", async ({
    run,
  }) => {
    const conversation = await run(slackMention("Reply with exactly: done"));

    expect(conversation.replies).toHaveLength(1);
    expect(conversation.statuses[0]).not.toBe("");
    expect(conversation.statuses.at(-1)).toBe("");
    // A channel thread has no title in Slack. The dashboard has the title.
    expect(conversation.threadTitles).toEqual([]);
  });

  test("when a direct message is not in a thread, Junior shows no status and gives no thread title", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("How do I debug a Node.js memory leak in production?", {
        channelType: "im",
      }),
    );

    expect(conversation.replies).toHaveLength(1);
    expect(conversation.statuses).toEqual([]);
    expect(conversation.threadTitles).toEqual([]);
    expect(conversation.title).toMatch(/leak/i);
  });

  test("when a person writes in an assistant thread, Junior shows a status and gives the thread the title of the request one time", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("How do I debug a Node.js memory leak in production?", {
        assistantThread: true,
      }),
    );

    expect(conversation.replies).toHaveLength(1);
    expect(conversation.statuses[0]).not.toBe("");
    expect(conversation.statuses.at(-1)).toBe("");
    // Junior names a new assistant thread before the person writes.
    expect(conversation.threadTitles).toEqual(["Junior", conversation.title]);
    expect(conversation.title).toMatch(/leak/i);

    const next = await conversation.continue(
      slackMention("Which tool shows the heap of a running process?"),
    );

    expect(next.replies).toHaveLength(1);
    expect(next.threadTitles).toEqual([]);
    expect(next.title).toBe(conversation.title);
  });
});
