import { describe } from "vitest";
import { mention, rubric, slackEval } from "../helpers";

describe("Slack mrkdwn hygiene", () => {
  slackEval(
    "uses single-asterisk bold, single-tilde strike, and Slack link syntax",
    {
      events: [
        mention(
          "In one short Slack reply, bold the word 'ready', strike through the word 'draft', and link the label 'docs' to https://docs.slack.dev/ .",
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
          "Emphasis and link syntax follow Slack `mrkdwn`: single-asterisk bold, single-tilde strike, and `<url|label>` links. CommonMark/GFM equivalents are forbidden.",
        pass: [
          "assistant_posts contains a single reply that addresses the bold, strike, and link asks.",
          "Bold uses `*ready*` (single asterisks).",
          "Strike uses `~draft~` (single tildes).",
          "The docs link appears as `<https://docs.slack.dev/|docs>` or the bare URL.",
        ],
        fail: [
          "Do not emit `**ready**` (CommonMark bold).",
          "Do not emit `~~draft~~` (CommonMark strike).",
          "Do not emit `[docs](https://docs.slack.dev/)` (CommonMark link).",
        ],
      }),
    },
  );

  slackEval("uses bold section labels instead of markdown headings", {
    events: [
      mention(
        "Give me a two-section Slack reply with short headings 'Summary' and 'Next steps', each with one sentence under it.",
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
        "Section structure uses a bold label on its own line. Markdown heading syntax is forbidden because Slack does not render it.",
      pass: [
        "assistant_posts contains a single reply with two sections.",
        "Each section label appears as `*Summary*` and `*Next steps*` on their own lines (bold labels), followed by a sentence.",
      ],
      fail: [
        "Do not emit `# Summary`, `## Summary`, `### Summary`, or any other markdown heading syntax.",
        "Do not emit `**Summary**` (CommonMark bold).",
      ],
    }),
  });
});
