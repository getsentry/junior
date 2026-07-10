import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Research Reply Shape", slackEvals, (it) => {
  it("when summarizing multiple sources, show initial progress and return a concise answer without process chatter", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        mention(
          "Read these three sources and give me one brief, coherent summary of how modern Slack agent streaming works. Keep it short enough to fit in one normal Slack reply, and do not include code samples: https://docs.slack.dev/changelog/2025/10/7/chat-streaming , https://docs.slack.dev/reference/methods/chat.startStream/ , https://docs.slack.dev/reference/methods/chat.stopStream/ .",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The thread reply is a concise researched answer, not a status update or process note.",
          "The answer coherently summarizes Slack agent streaming across the provided sources.",
          "The answer stays brief enough for a normal Slack reply and does not create a canvas.",
        ],
        fail: [
          "Do not include process chatter such as 'let me check', 'fetching', or similar tool-progress narration.",
        ],
      }),
    });
  });

  it("when a long-form reference is requested as reusable material, create a canvas and keep the thread reply brief", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        mention(
          "Create a concise reusable canvas reference for modern Slack agent streaming that I can come back to later. Use these notes: Slack apps can stream AI responses with start, append, and stop stream methods; streamed messages should live in the user request thread; chunks can include markdown text and task updates; finalized messages can include blocks; apps need to account for content limits, rate limits, retries, and migration from single final replies. Keep the thread reply brief.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant creates a single useful canvas for the requested Slack streaming reference.",
          "The canvas is a structured artifact that covers the supplied Slack streaming notes.",
          "The thread reply stays brief and points to the canvas instead of pasting the full document inline.",
        ],
        fail: [
          "Do not paste the entire long-form reference artifact directly into the assistant thread reply.",
          "Do not create multiple canvases for this one research request.",
          "Do not add process chatter such as 'let me check', 'fetching', or similar tool-progress narration.",
          "Do not use web discovery when the prompt supplies the material to organize.",
        ],
      }),
    });
  });
});
