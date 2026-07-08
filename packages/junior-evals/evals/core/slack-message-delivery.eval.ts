import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { mention, rubric, slackEvals } from "../../src/helpers";

type EvalSession = Parameters<typeof assistantMessages>[0];

function textContent(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function visibleThreadReplies(session: EvalSession) {
  return assistantMessages(session).filter(
    (message) =>
      message.metadata?.event_type === "thread_post" &&
      textContent(message.content).trim().length > 0,
  );
}

function visibleText(session: EvalSession): string {
  return assistantMessages(session)
    .map((message) => textContent(message.content))
    .join("\n");
}

describeEval("Slack Message Delivery", slackEvals, (it) => {
  it("when asked for no visible reply, complete silently", async ({ run }) => {
    const result = await run({
      events: [
        mention(
          "please record that this has been seen, but do not post a visible reply",
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant posts no visible thread reply.",
          `The no-reply marker ${NO_REPLY_MARKER} is only an internal publication signal.`,
        ],
        fail: [
          "Do not post an acknowledgement such as 'Done', 'Seen', or 'Got it'.",
          `Do not leak the literal marker ${NO_REPLY_MARKER} as visible text.`,
        ],
      }),
    });

    expect(visibleThreadReplies(result.session)).toEqual([]);
    expect(visibleText(result.session)).not.toContain(NO_REPLY_MARKER);
  });

  it("when asked for a top-level channel post, explain the limitation instead", async ({
    run,
  }) => {
    const result = await run({
      events: [mention("@bot post this to the channel: deploy is unblocked")],
      criteria: rubric({
        pass: [
          "The assistant does not call sendMessage.",
          "The assistant posts exactly one visible thread reply.",
          "The reply clearly explains it cannot make top-level channel posts from this runtime or can only send into the active conversation/thread.",
        ],
        fail: [
          "Do not send the requested text into the active thread with sendMessage.",
          "Do not claim the message was posted to the channel.",
          `Do not leak the literal marker ${NO_REPLY_MARKER} as visible text.`,
        ],
      }),
    });

    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "sendMessage",
    );
    expect(visibleText(result.session)).not.toContain(NO_REPLY_MARKER);
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  it("when a generated image should be shared here, send it to the thread", async ({
    run,
  }) => {
    const result = await run({
      overrides: { mock_image_generation: true },
      events: [
        mention("make a small image of a launch checklist and share it here"),
      ],
      criteria: rubric({
        pass: [
          "The assistant generates an image and sends or attaches it in the current Slack thread.",
          "The assistant may include a brief normal thread reply, but it does not post the image as a top-level channel message.",
        ],
        fail: [
          "Do not only describe the image in text.",
          "Do not post the image to the channel when the user asked to share it here.",
          "Do not include sandbox setup failure text.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "imageGenerate" }),
        expect.objectContaining({
          name: "sendMessage",
        }),
      ]),
    );
    const sendMessageCall = toolCalls(result.session).find(
      (call) => call.name === "sendMessage",
    );
    expect(sendMessageCall?.arguments).not.toHaveProperty("target");
    expect(visibleText(result.session)).not.toContain(NO_REPLY_MARKER);
    expect(visibleThreadReplies(result.session).length).toBeGreaterThan(0);
  });
});
