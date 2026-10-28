import { describe, expect } from "vitest";
import { slackAppMessage, slackMention } from "@junior-evals/fixture/inputs";
import { test } from "@junior-evals/fixture/test";

const RUN_ID = "536be3d5-76e9-4d2c-b172-9756b5b4e6fc";
const ALERT =
  "Production deploy failed: OOM on pod-42. Service: checkout. Source: Datadog Monitor";

describe("Slack Message Content", () => {
  test("when a link shows shortened text, the reply uses the full link target", async ({
    run,
  }) => {
    // Slack shows the label to people. Only the link target has the run id.
    const conversation = await run(
      slackMention(
        `What is the run id in this link? <https://ci.example.com/runs/${RUN_ID}|ci.example.com/runs/…>`,
      ),
    );

    expect(conversation.replies.at(-1)?.text).toContain(RUN_ID);
  });

  test("when a mention forwards a message, the reply uses the forwarded message", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("Which service does this alert name?", { forwarded: ALERT }),
    );

    expect(conversation.replies.at(-1)?.text).toMatch(/checkout/i);
  });

  test("when a mention is under an app message, the reply uses the app message", async ({
    run,
  }) => {
    // Junior never received the app message, so the turn reads it from Slack.
    const conversation = await run(
      slackMention("Which service does this alert name?"),
      { history: [slackAppMessage(ALERT)] },
    );

    expect(conversation.replies.at(-1)?.text).toMatch(/checkout/i);
  });
});
