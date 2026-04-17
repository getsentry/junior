import { describe } from "vitest";
import { mention, rubric, slackEval } from "../helpers";

describe("Research Reply Shape", () => {
  slackEval(
    "when summarizing multiple sources, return a concise answer without process chatter",
    {
      events: [
        mention(
          "Read these three sources and give me one brief, coherent summary of how modern Slack agent streaming works. Keep it short enough to fit in one normal Slack reply, and do not include code samples: https://docs.slack.dev/ai/developing-agents/ , https://docs.slack.dev/reference/methods/chat.startStream/ , https://docs.slack.dev/reference/methods/chat.stopStream/ .",
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
          "A multi-source research request returns a concise Slack-style answer without process chatter.",
        pass: [
          "assistant_posts contains one concise researched answer, or at most one clearly intentional continuation if needed.",
          "The primary assistant post begins with the researched answer itself, not internal work narration.",
          "The answer coherently summarizes how Slack agent streaming works across the provided sources.",
          "The answer stays brief rather than turning into a long document or code sample.",
          "channel_posts is empty.",
          "reactions is empty.",
        ],
        fail: [
          "Do not include process chatter such as 'let me check', 'fetching', or similar tool-progress narration.",
          "Do not send caveats about inaccessible or partial sources as a stray status-like note.",
        ],
      }),
    },
  );
});
