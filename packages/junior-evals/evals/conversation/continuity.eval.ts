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
// This CI log is about 51,000 tokens. The answer must come from the summary.
const CI_LOG = Array.from(
  { length: 1_800 },
  (_, index) =>
    `2026-03-02T09:${String(index % 60).padStart(2, "0")}:00Z [integration (postgres)] vitest worker ${index % 8} passed tests/integration/case-${String(index + 1).padStart(4, "0")}.test.ts in ${100 + (index % 900)}ms`,
).join("\n");
const LONG_THREAD = [
  slackMention(
    "CI on getsentry/junior#4821 is red since the queue refactor. Can you find out why?",
  ),
  reply(
    "The `integration (postgres)` job fails in tests/integration/durable-queue.test.ts with `TypeError: Cannot read properties of undefined (reading 'seq')`. It started with commit 9f3c2ab.",
  ),
  slackMention("Paste the full log of that job."),
  reply(`Log of the integration (postgres) job:\n${CI_LOG}`),
  slackMention(
    "ok. when you fix it, also add a regression test for the empty queue case and ping Dana on the PR",
  ),
  reply("Will do. I'll start with the fix for the failing test."),
];

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

  test.for([
    {
      probe: "In one sentence, what did I ask you to do that is still open?",
      pass: "The reply names the regression test for the empty queue case or pinging Dana on the PR.",
    },
    {
      probe: "In one sentence, which PR are we working on?",
      pass: "The reply names getsentry/junior#4821 or PR 4821.",
    },
    {
      probe: "In one sentence, what failed?",
      pass: "The reply says the integration (postgres) job or durable-queue test fails with a TypeError about reading 'seq'.",
    },
  ])(
    "when a long thread was compacted, answer $probe from the summary",
    async ({ probe, pass }, { agent }) => {
      const { run } = await agent({
        limits: { contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS },
      });
      const conversation = await run(slackMention(probe), {
        history: LONG_THREAD,
      });
      await expect(conversation).toSatisfyJudge(
        RubricJudge,
        rubric({ pass: [pass] }),
      );

      expect(conversation.compactions).toBeGreaterThan(0);
      expect(conversation.replies).toHaveLength(1);
    },
  );
});
