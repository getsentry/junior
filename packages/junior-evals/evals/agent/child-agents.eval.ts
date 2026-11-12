import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Child Agent Results", () => {
  test("when a child agent uses its turn budget, report its progress instead of a failure", async ({
    agent,
  }) => {
    // Three tool calls stand in for a spent budget. Past the limit, Junior
    // blocks the next tool call and asks the child to reply with its progress.
    const { run } = await agent({
      limits: { maxToolCallsPerTurn: 3 },
    });
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Call systemTime five times, one call per step. Then reply with how many of the calls returned a time." When its result arrives, tell me what the child agent reported.',
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The last reply says the child agent stopped before all five calls ran, and it gives the number of calls that ran.",
        ],
        fail: ["The last reply says the child agent failed with an error."],
      }),
    );
  });
});
