import { describeEval, toolCalls } from "vitest-evals";
import { beforeAll, expect } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  hasImageAttachment,
  mention,
  rubric,
  slackEvals,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../../src/helpers";
import { warmSandboxSnapshot } from "../../../src/snapshot-warmup";

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

  it("when a task needs a progress update, use status before one completed reply", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "Tell me the current UTC time, and keep me posted while you check.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant returns the requested UTC time in one concise completed reply.",
        ],
        fail: [
          "Do not post intermediate process narration, cumulative drafts, or repeated copies of the reply.",
        ],
      }),
    });

    const callNames = toolCalls(result.session).map((call) => call.name);
    expect(callNames).toContain("reportProgress");
    expect(callNames).toContain("systemTime");
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  it("when asked to show an image, attach it without process chatter", async ({
    run,
  }) => {
    const result = await run({
      overrides: { mock_image_generation: true },
      initialEvents: [mention("show me an image of a red panda")],
      criteria: rubric({
        pass: [
          "Any visible text is limited to at most one concise acknowledgement that the requested image was delivered.",
        ],
        fail: [
          "Do not narrate image generation, file lookup, attachment paths, permission checks, retries, or other internal process steps.",
          "Do not post multiple progress or troubleshooting messages before the image.",
        ],
      }),
    });

    const imageGenerateCalls = toolCalls(result.session).filter(
      (call) => call.name === "imageGenerate",
    );
    const sendFilesCalls = toolCalls(result.session).filter(
      (call) => call.name === "sendFiles",
    );

    expect(imageGenerateCalls).toHaveLength(1);
    expect(sendFilesCalls).toEqual([
      expect.objectContaining({
        status: "ok",
        result: expect.objectContaining({
          file_count: 1,
          file_ids: expect.arrayContaining([expect.any(String)]),
        }),
      }),
    ]);
    expect(hasImageAttachment(result.session)).toBe(true);
    expect(visibleAssistantText(result.session)).not.toContain(NO_REPLY_MARKER);
    expect(visibleThreadReplies(result.session).length).toBeLessThanOrEqual(1);
  });
});
