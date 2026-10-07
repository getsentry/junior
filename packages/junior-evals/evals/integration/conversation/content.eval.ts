import { describe, expect } from "vitest";
import { appMessage, mention } from "@junior-evals/fixture/inputs";
import { test } from "@junior-evals/fixture/test";

const RUN_ID = "536be3d5-76e9-4d2c-b172-9756b5b4e6fc";

describe("Slack Message Content", () => {
  test("when a link shows shortened text, the reply uses the full link target", async ({
    run,
  }) => {
    // Slack shows the label to people. Only the link target has the run id.
    const conversation = await run(
      mention(
        `What is the run id in this link? <https://ci.example.com/runs/${RUN_ID}|ci.example.com/runs/…>`,
      ),
    );

    expect(conversation.replies.at(-1)?.text).toContain(RUN_ID);
  });

  test("when a mention has an attachment, the reply uses the attachment text", async ({
    run,
  }) => {
    const conversation = await run(
      mention("Which service does this alert name?", {
        attachments: [
          {
            fallback: "Deploy failed on production",
            title: "Production deploy",
            text: "OOM on pod-42",
            fields: [{ title: "Service", value: "checkout" }],
            footer: "Datadog Monitor",
          },
        ],
      }),
    );

    expect(conversation.replies.at(-1)?.text).toMatch(/checkout/i);
  });

  test("when a mention is under an app message, the reply uses the blocks of the app message", async ({
    run,
  }) => {
    // Junior never received the app message, so the turn reads it from Slack.
    const conversation = await run(mention("Who left this review?"), {
      history: [
        appMessage("", {
          attachments: [
            {
              fallback: "[no preview available]",
              blocks: [
                {
                  type: "section",
                  text: { type: "plain_text", text: "Taylor Example" },
                },
                {
                  type: "section",
                  text: { type: "plain_text", text: "The app never loaded" },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Read full review" },
                      url: "https://example.com/review/123",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    });

    expect(conversation.replies.at(-1)?.text).toContain("Taylor Example");
  });
});
