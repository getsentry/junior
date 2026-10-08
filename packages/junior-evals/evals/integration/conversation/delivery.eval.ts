import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Slack Message Delivery", () => {
  test("when asked for no visible reply, complete silently", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "please just mark that this has been seen — no need to reply",
      ),
    );

    expect(completedToolCalls("addReaction", conversation)).not.toHaveLength(0);
    expect(conversation.replies).toEqual([]);
  });

  test("when asked for a top-level channel post, explain the limitation instead", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("post this to the channel: deploy is unblocked"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply clearly explains it cannot make top-level channel posts from this runtime or can only send into the active conversation/thread.",
        ],
        fail: [
          "Do not present the requested channel text as if it was delivered.",
          "Do not claim the message was posted to the channel.",
        ],
      }),
    );

    expect(completedToolCalls("sendFiles", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
  });

  test("when asked for updates on a quick task, send one completed reply", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Tell me the current UTC time, and keep me posted while you check.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant returns the requested UTC time in one concise completed reply.",
        ],
        fail: [
          "Do not post intermediate process narration, cumulative drafts, or repeated copies of the reply.",
        ],
      }),
    );

    // Progress updates are optional for a task this short. The contract is
    // a grounded answer in one reply, without visible narration.
    expect(completedToolCalls("systemTime", conversation)).not.toHaveLength(0);
    expect(conversation.replies).toHaveLength(1);
  });

  test("when asked to show an image, attach it without process chatter", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("show me an image of a red panda"),
    );
    // Junior can send the image with no text. The judge reads text only, so
    // it has nothing to score then.
    if (conversation.replies.length > 0) {
      await expect(conversation).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "Any visible text is limited to at most one concise acknowledgement that the requested image was delivered.",
          ],
          fail: [
            "Do not narrate image generation, file lookup, attachment paths, permission checks, retries, or other internal process steps.",
            "Do not post multiple progress or troubleshooting messages before the image.",
          ],
        }),
      );
    }

    expect(completedToolCalls("imageGenerate", conversation)).toHaveLength(1);
    const sendFiles = completedToolCalls("sendFiles", conversation);
    expect(sendFiles).toHaveLength(1);
    expect(toolOutput(sendFiles[0]!)).toMatchObject({
      attachment_refs: [
        { id: expect.any(String), filename: expect.any(String) },
      ],
    });
    expect(conversation.files).toHaveLength(1);
    // The image is a separate Slack upload; limit acknowledgements, not files.
    expect(conversation.replies.length).toBeLessThanOrEqual(1);
  });
});
