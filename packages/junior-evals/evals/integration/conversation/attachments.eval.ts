import { describe, expect } from "vitest";
import {
  TICKET_NUMBER,
  ticketScreenshotPng,
} from "@junior-evals/fixture/images";
import {
  file,
  slackMention,
  reply,
  slackThreadMessage,
  unavailableFile,
  webMessage,
} from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

// Only the pixels have the ticket number, so a reply with the number proves
// that Junior read the image.
const SCREENSHOT = file("screenshot.png", "image/png", ticketScreenshotPng());

describe("Conversation Attachments", () => {
  test("when a direct message has an image, the reply uses the image", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("What is the ticket number in this screenshot?", {
        channelType: "im",
        files: [SCREENSHOT],
      }),
    );

    expect(conversation.replies.at(-1)?.text).toContain(TICKET_NUMBER);
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
  });

  test("when a web message has an image, the reply uses the image", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage("What is the ticket number in this screenshot?", {
        images: [SCREENSHOT],
      }),
    );

    expect(conversation.replies.at(-1)?.text).toContain(TICKET_NUMBER);
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
  });

  test("when a mention asks about an image from an earlier thread message, the reply uses the image", async ({
    run,
  }) => {
    // Junior does not answer the thread message, so no turn reads its image.
    const skipped = await run(
      slackThreadMessage("Here is the screenshot.", { files: [SCREENSHOT] }),
      {
        history: [
          slackMention(
            "I will post a screenshot of the ticket in this thread.",
          ),
          reply("Okay, post it here."),
        ],
      },
    );
    expect(skipped.turns).toEqual([]);

    const conversation = await skipped.continue(
      slackMention("What is the ticket number in the screenshot above?"),
    );

    expect(conversation.replies.at(-1)?.text).toContain(TICKET_NUMBER);
  });

  test("when the vision model cannot read an image, the reply says that Junior could not read it", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("What is the ticket number in this screenshot?", {
        files: [file("screenshot.png", "image/png", "These bytes are no PNG.")],
      }),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply says that Junior could not read the screenshot."],
        fail: [
          "Do not give a ticket number.",
          "Do not say that no file was attached.",
        ],
      }),
    );

    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
  });

  test("when Slack cannot serve one file of a mention, the reply uses the other file and names the unreadable file", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("Who owns the rollback? Could you read both files?", {
        files: [
          file(
            "handoff.txt",
            "text/plain",
            "The rollback owner for the checkout outage is Dana.",
          ),
          unavailableFile("timeline.json", "application/json"),
        ],
      }),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says Dana owns the rollback.",
          "The reply says that timeline.json could not be read.",
        ],
        fail: ["Do not say that no file was attached."],
      }),
    );

    expect(conversation.replies).toHaveLength(1);
  });

  test("when two mentions arrive before the turn starts, the turn reads the file of the first mention", async ({
    run,
  }) => {
    const conversation = await run([
      slackMention("Read this handoff first.", {
        files: [
          file(
            "handoff.txt",
            "text/plain",
            "The rollback owner for the checkout outage is Dana.",
          ),
        ],
      }),
      slackMention("In one sentence, who is the rollback owner?"),
    ]);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({ pass: ["The reply says Dana is the rollback owner."] }),
    );

    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
  });
});
