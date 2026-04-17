import { describe } from "vitest";
import { mention, rubric, slackEval } from "../helpers";

describe("Slack Render Intents", () => {
  slackEval(
    "when the user asks for a comparison table, render via the comparison_table intent",
    {
      events: [
        mention(
          "Give me a short comparison table of three error tracking tools: Sentry, Bugsnag, and Rollbar. Columns should be Best for, Strengths, and Tradeoffs. Keep each cell short.",
        ),
      ],
      overrides: {
        reply_timeout_ms: 120_000,
      },
      requireSandboxReady: false,
      taskTimeout: 150_000,
      timeout: 210_000,
      criteria: rubric({
        contract:
          "An explicit request for a comparison table is rendered via the reply tool using the `comparison_table` intent, not as GFM pipe-table text.",
        pass: [
          "reply_intents has exactly one entry and its kind is 'comparison_table'.",
          "That entry's payload lists at least 2 columns and at least 2 rows that meaningfully compare the three tools.",
          "No assistant_posts entry contains GFM pipe-table syntax (lines like `| col | col |` or a `|---|` separator row).",
          "assistant_posts contains one post that communicates the comparison clearly; if its text body is present it is the fallback rendering of the table (short prose or newline-separated cells), not a markdown table.",
        ],
        fail: [
          "Do not emit a response that relies on markdown pipe-table syntax to convey the comparison.",
          "Do not emit `**bold**` (double asterisks), `[label](url)` markdown links, or `##` headings — Slack does not render them.",
          "Do not call the reply tool with any kind other than `comparison_table` for this turn.",
        ],
      }),
    },
  );

  slackEval(
    "when the user asks a plain conversational question, reply in mrkdwn without calling the reply tool",
    {
      events: [
        mention(
          "In one sentence, what is an error tracking tool typically used for?",
        ),
      ],
      overrides: {
        reply_timeout_ms: 60_000,
      },
      requireSandboxReady: false,
      taskTimeout: 90_000,
      timeout: 150_000,
      criteria: rubric({
        contract:
          "A plain conversational question is answered in ordinary Slack mrkdwn text without invoking the reply tool.",
        pass: [
          "reply_intents is empty.",
          "assistant_posts contains exactly one short answer in ordinary prose.",
          "The answer contains no markdown pipe-table syntax, no `##` headings, no `[label](url)` markdown links, and no `**bold**` double-asterisks.",
        ],
        fail: [
          "Do not call the reply tool for a turn that only needs a short prose answer.",
          "Do not wrap the answer in a summary_card, alert, or other structured intent.",
        ],
      }),
    },
  );
});
