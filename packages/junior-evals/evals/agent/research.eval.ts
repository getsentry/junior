import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Research Reply Shape", () => {
  test("when summarizing multiple sources, show initial progress and return a concise answer without process chatter", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "Read these three sources and give me one brief, coherent summary of how modern Slack agent streaming works. Keep it short enough to fit in one normal Slack reply, and do not include code samples: https://docs.slack.dev/changelog/2025/10/7/chat-streaming , https://docs.slack.dev/reference/methods/chat.startStream/ , https://docs.slack.dev/reference/methods/chat.stopStream/ .",
      ),
      {
        criteria: rubric({
          pass: [
            "The final thread reply is a concise researched answer, not a status update or process note.",
            "The final answer coherently summarizes Slack agent streaming across the provided sources.",
            "The final answer stays brief enough for a normal Slack reply.",
          ],
          fail: [
            "Do not expose low-level tool mechanics, partial drafts, or repetitive progress updates.",
          ],
        }),
      },
    );

    expect(completedToolCalls("slackCanvasCreate", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
    expect(conversation.replies[0]!.text.length).toBeLessThanOrEqual(800);
  });

  test("when a long-form reference is requested as reusable material, create a canvas and keep the thread reply brief", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "Create a concise reusable canvas reference for modern Slack agent streaming that I can come back to later. Use these notes: Slack apps can stream AI responses with start, append, and stop stream methods; streamed messages should live in the user request thread; chunks can include markdown text and task updates; finalized messages can include blocks; apps need to account for content limits, rate limits, retries, and migration from single final replies. Keep the thread reply brief.",
      ),
      {
        criteria: rubric({
          pass: [
            "The thread reply stays brief and points to the canvas instead of pasting the full document inline.",
          ],
          fail: [
            "Do not paste the entire long-form reference artifact directly into the assistant thread reply.",
            "Do not add process chatter such as 'let me check', 'fetching', or similar tool-progress narration.",
          ],
        }),
      },
    );

    expect(
      completedToolCalls("slackCanvasCreate", conversation).map(
        (call) => call.input,
      ),
    ).toEqual([
      expect.objectContaining({ markdown: expect.stringMatching(/stream/i) }),
    ]);
  });
});
