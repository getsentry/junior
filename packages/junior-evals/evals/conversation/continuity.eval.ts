import { describe, expect } from "vitest";
import { slackMention, reply } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

// Junior compacts agent history above 90% of the context window, at about 4
// characters per token. This build log is about 56,000 tokens, so it does not
// fit a 50,000 token window. Checksums are pseudo-random, so a summary cannot
// recreate one.
const SMALL_CONTEXT_WINDOW_TOKENS = 50_000;
const checksum = (step: number) =>
  (Math.imul(step + 1, 2_654_435_761) >>> 0).toString(16).padStart(8, "0");
const BUILD_LOG = Array.from(
  { length: 3_500 },
  (_, index) =>
    `2026-03-01T04:${String(index % 60).padStart(2, "0")}:00Z step ${String(index + 1).padStart(4, "0")} ok checksum ${checksum(index + 1)} region iad1`,
).join("\n");

describe("Thread Continuity", () => {
  test("when a follow-up asks about the prior turn, recall the earlier budget context", async ({
    run,
  }) => {
    const conversation = await run(slackMention("what did i just ask?"), {
      history: [
        slackMention("I need the budget by Friday."),
        reply("Got it: budget due Friday."),
      ],
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    );

    expect(conversation.replies).toHaveLength(1);
  });

  test("when a compacted tool result holds an exact detail, read the full result back", async ({
    agent,
  }) => {
    const { run } = await agent({
      limits: { contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS },
    });
    const conversation = await run(
      slackMention(
        "What was the exact checksum on step 0042 of that build log? I need to paste it into the release ticket.",
      ),
      {
        history: [
          slackMention("Can you pull the full build log for build 7421?"),
          reply("Build 7421 finished. All 3,500 steps passed in iad1.", {
            toolHistory: [
              {
                name: "bash",
                arguments: { command: "cat logs/build-7421.log" },
                result: {
                  exit_code: 0,
                  stdout: BUILD_LOG,
                  stderr: "",
                  timed_out: false,
                },
              },
            ],
          }),
        ],
      },
    );

    expect(conversation.compactions).toBeGreaterThan(0);
    // The checksum is only in the compacted tool result.
    expect(conversation.replies.map((item) => item.text).join("\n")).toContain(
      checksum(42),
    );
  });
});
