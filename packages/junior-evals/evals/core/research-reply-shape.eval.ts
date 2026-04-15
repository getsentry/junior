import { describe } from "vitest";
import { mention, slackEval } from "../helpers";

describe("Conversational Evals: Research Reply Shape", () => {
  slackEval("research: multi-source request avoids process chatter", {
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
    criteria:
      "assistant_posts contains one concise Slack-style answer, or at most one clearly intentional continuation if needed. The primary assistant post begins with the researched answer itself, not with internal work narration. The answer coherently summarizes how Slack agent streaming works across the provided sources and stays brief rather than turning into a long document or code sample. No assistant post includes process chatter such as 'let me check', 'fetching', 'I now have enough context', or similar tool-progress narration. If caveats about inaccessible or partial sources appear, they are integrated into the answer or a clearly labeled continuation, not sent as a stray status-like note. channel_posts is empty. reactions is empty.",
  });
});
