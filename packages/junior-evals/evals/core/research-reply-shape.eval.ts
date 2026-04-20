import { describe } from "vitest";
import {
  assertMeaningfulExplicitProgress,
  mention,
  rubric,
  slackEval,
} from "../helpers";

describe("Research Reply Shape", () => {
  slackEval(
    "when summarizing multiple sources, show progress and return a concise answer without process chatter",
    {
      events: [
        mention(
          "Read these three sources and give me one brief, coherent summary of how modern Slack agent streaming works. Keep it short enough to fit in one normal Slack reply, and do not include code samples: https://docs.slack.dev/ai/developing-agents/ , https://docs.slack.dev/reference/methods/chat.startStream/ , https://docs.slack.dev/reference/methods/chat.stopStream/ .",
        ),
      ],
      overrides: {
        reply_timeout_ms: 120_000,
      },
      assertResult: assertMeaningfulExplicitProgress,
      requireSandboxReady: false,
      taskTimeout: 150_000,
      timeout: 210_000,
      criteria: rubric({
        contract:
          "A multi-source research request returns a concise Slack-style answer without process chatter.",
        pass: [
          "assistant_posts contains one concise researched answer, or at most one clearly intentional continuation if needed.",
          "canvases is empty because this short request fits in a normal Slack reply.",
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

  slackEval(
    "when long-form research is requested as a reusable reference, create a canvas and keep the thread reply brief",
    {
      events: [
        mention(
          "Read these three sources and put together a detailed timeline and implementation reference for modern Slack agent streaming that I can come back to later. Cover how the APIs evolved, the key methods, the current limits, and the migration gotchas: https://docs.slack.dev/ai/developing-agents/ , https://docs.slack.dev/reference/methods/chat.startStream/ , https://docs.slack.dev/reference/methods/chat.stopStream/ .",
        ),
      ],
      overrides: {
        reply_timeout_ms: 140_000,
      },
      requireSandboxReady: false,
      taskTimeout: 180_000,
      timeout: 240_000,
      criteria: rubric({
        contract:
          "A long-form research deliverable becomes a Slack canvas, with the thread reserved for a short summary and pointer.",
        pass: [
          "canvases contains exactly one created canvas.",
          "That canvas title clearly matches the requested Slack streaming research or timeline deliverable.",
          "That canvas markdown is a substantial structured artifact with sections or bullets, not a tiny stub.",
          "The canvas content covers the requested research areas such as the timeline or evolution, the key APIs, and current limits or migration gotchas.",
          "assistant_posts contains one brief thread reply that points the user to the canvas instead of pasting the whole document inline.",
          "channel_posts is empty.",
          "reactions is empty.",
        ],
        fail: [
          "Do not paste the entire long-form research artifact directly into assistant_posts.",
          "Do not create multiple canvases for this one research request.",
          "Do not add process chatter such as 'let me check', 'fetching', or similar tool-progress narration.",
        ],
      }),
    },
  );
});
