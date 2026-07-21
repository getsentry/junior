import { describeEval, toolCalls } from "vitest-evals";
import { beforeAll, expect } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  assistantTextContent,
  hasImageAttachment,
  mention,
  rubric,
  slackEvals,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../src/helpers";
import { warmSandboxSnapshot } from "../../src/snapshot-warmup";

const SNAPSHOT_WARMUP_TIMEOUT_MS = 10 * 60 * 1000;

describeEval("Slack Message Delivery", slackEvals, (it) => {
  beforeAll(async () => {
    await warmSandboxSnapshot();
  }, SNAPSHOT_WARMUP_TIMEOUT_MS);

  it("when asked for no visible reply, complete silently", async ({ run }) => {
    const result = await run({
      initialEvents: [
        mention(
          "please record that this has been seen, but do not post a visible reply",
        ),
      ],
    });

    expect(toolCalls(result.session).map((call) => call.name)).toContain(
      "addReaction",
    );
    expect(visibleThreadReplies(result.session)).toEqual([]);
    expect(visibleAssistantText(result.session)).not.toContain(NO_REPLY_MARKER);
  });

  it("when asked for a top-level channel post, explain the limitation instead", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention("@bot post this to the channel: deploy is unblocked"),
      ],
      criteria: rubric({
        pass: [
          "The reply clearly explains it cannot make top-level channel posts from this runtime or can only send into the active conversation/thread.",
        ],
        fail: [
          "Do not present the requested channel text as if it was delivered.",
          "Do not claim the message was posted to the channel.",
          `Do not leak the literal marker ${NO_REPLY_MARKER} as visible text.`,
        ],
      }),
    });

    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "sendFiles",
    );
    expect(visibleAssistantText(result.session)).not.toContain(NO_REPLY_MARKER);
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  it("when a task needs a progress update, post complete messages rather than partial revisions", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "Tell me the current UTC time. Send a short update before you check, then give me the answer separately when you're done.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant sends a distinct progress update before a separate completed summary.",
          "Each visible assistant message reads as a complete message at that point in the work.",
        ],
        fail: [
          "Do not expose token-by-token fragments, cumulative drafts, or repeated copies of the same reply.",
        ],
      }),
    });

    expect(
      toolCalls(result.session).some((call) => call.name === "systemTime"),
    ).toBe(true);
    const replies = visibleThreadReplies(result.session);
    expect(replies.length).toBeGreaterThanOrEqual(2);
    const replyTexts = replies.map((reply) =>
      assistantTextContent(reply.content).trim(),
    );
    expect(new Set(replyTexts).size).toBe(replyTexts.length);
  });

  it("when a generated image should be shared here, send it to the thread", async ({
    run,
  }) => {
    const result = await run({
      overrides: { mock_image_generation: true },
      initialEvents: [
        mention("make a small image of a launch checklist and share it here"),
      ],
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "imageGenerate" }),
        expect.objectContaining({
          name: "sendFiles",
        }),
      ]),
    );
    const sendFilesCall = toolCalls(result.session).find(
      (call) => call.name === "sendFiles",
    );
    expect(sendFilesCall).toMatchObject({
      status: "ok",
      result: { ok: true, status: "success" },
    });
    expect(hasImageAttachment(result.session)).toBe(true);
    expect(visibleAssistantText(result.session)).not.toContain(NO_REPLY_MARKER);
    expect(visibleThreadReplies(result.session).length).toBeGreaterThan(0);
  });
});
