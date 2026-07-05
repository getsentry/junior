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

function sendMessageTargets(session: EvalSession): unknown[] {
  return toolCalls(session)
    .filter((call) => call.name === "sendMessage")
    .map((call) => call.arguments?.target);
}

describeEval("Slack Message Delivery", slackEvals, (it) => {
  it("when asked to post in channel, send a channel message without duplicate thread text", async ({
    run,
  }) => {
    const result = await run({
      events: [mention("@bot say hello to the channel!")],
      criteria: rubric({
        pass: [
          "The normalized transcript contains exactly one hello-style channel_post assistant message with no thread_ts.",
          "The assistant tool calls include sendMessage with channel target for the requested channel post.",
          "The normalized transcript does not contain that hello-style message as a thread reply.",
        ],
        fail: [
          "Do not add a redundant thread reply acknowledging the channel post.",
          `Do not leak the literal marker ${NO_REPLY_MARKER} as visible text.`,
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "sendMessage",
          arguments: expect.objectContaining({ target: "channel" }),
        }),
      ]),
    );
    expect(visibleThreadReplies(result.session)).toEqual([]);
    expect(visibleText(result.session)).not.toContain(NO_REPLY_MARKER);
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
          arguments: expect.objectContaining({ target: "thread" }),
        }),
      ]),
    );
    expect(sendMessageTargets(result.session)).toContain("thread");
    expect(sendMessageTargets(result.session)).not.toContain("channel");
    expect(visibleText(result.session)).not.toContain(NO_REPLY_MARKER);
    expect(visibleThreadReplies(result.session).length).toBeGreaterThan(0);
  });

  it("when a generated image should be posted to the channel, use channel target", async ({
    run,
  }) => {
    const result = await run({
      overrides: { mock_image_generation: true },
      events: [
        mention(
          "make a small launch checklist image and post it to the channel",
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant generates an image and posts it as a top-level channel message.",
          "The assistant does not duplicate that channel post as a normal thread attachment.",
        ],
        fail: [
          "Do not only describe the image in text.",
          "Do not send the image only into the thread when the user asked to post it to the channel.",
          "Do not add a redundant thread reply that repeats the posted channel message.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "imageGenerate" }),
        expect.objectContaining({
          name: "sendMessage",
          arguments: expect.objectContaining({ target: "channel" }),
        }),
      ]),
    );
    expect(sendMessageTargets(result.session)).toContain("channel");
    expect(sendMessageTargets(result.session)).not.toContain("thread");
  });
});
