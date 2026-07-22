import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  rubric,
  slackEvals,
  slackSideEffects,
  threadStart,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Lifecycle and Resilience", slackEvals, (it) => {
  it("when an assistant thread starts, set title and prompts without posting a reply", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [threadStart()],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(0);
    expect(slackSideEffects(result)).toMatchObject({
      suggestedPromptCalls: 1,
      threadTitleCalls: 1,
    });
  });

  it("when a sandbox command crosses a turn deadline, continue the task to completion", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        skill_dirs: ["fixtures/coding-skills"],
        reply_timeout_ms: 60_000,
        turn_timeout_ms: 40_000,
      },
      initialEvents: [
        mention(
          "In the eval coding fixture, immediately run `bash skills/coding-workspace-fixture/project/slow-integration-test.sh` with the bash tool's timeoutMs set to 120000. Do not use a shorter tool timeout or poll the command. Keep working until it succeeds, then report the exact contents of slow-test-result.txt.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The final reply says the slow integration test passed after continuation.",
          "The assistant finishes the requested work instead of stopping after the interrupted command.",
        ],
        fail: [
          "Do not give an interruption-only status report or ask the user to retry.",
          "Do not claim success without reporting the result file's exact contents.",
        ],
      }),
    });

    const slowTestCalls = toolCalls(result.session).filter((call) =>
      JSON.stringify(call.arguments).includes("slow-integration-test"),
    );
    expect(slowTestCalls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(slowTestCalls)).toContain("outcome_unknown");
  });
});
