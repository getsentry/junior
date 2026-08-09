import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Slack User Status", slackEvals, (it) => {
  it("when no custom status is set, report that it is unset", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("Am I marked out of office in Slack right now?")],
      criteria: rubric({
        pass: [
          "The assistant clearly says the user does not currently have a custom Slack status set.",
        ],
        fail: [
          "Do not claim that Junior's Slack user lookup tool omits status fields or cannot read Slack status.",
          "Do not claim that a users.profile:read scope or connector configuration change is required.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual([
      expect.objectContaining({
        name: "userLookup",
        arguments: { mode: "user_id", value: "U0TEST" },
        status: "ok",
      }),
    ]);
  });
});
