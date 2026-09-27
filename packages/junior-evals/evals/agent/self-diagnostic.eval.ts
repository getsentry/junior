import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import {
  mention,
  rubric,
  slackEvals,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Self diagnostic", slackEvals, (it) => {
  it("reads current model settings instead of repeating a remembered handoff model", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "What is your smart handoff model now, and which model is answering me? An old answer said Opus. Please check the live settings, not that old answer.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply distinguishes the active model from the model configured for handoff.",
          "The reply explains the verified result without claiming the model had to switch to inspect it.",
        ],
        fail: [
          "Do not present the old answer as proof of the live setting.",
          "Do not say live model settings are unavailable after a successful diagnostic lookup.",
        ],
      }),
    });
    const calls = toolCalls(result.session);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "self_diagnostic", status: "ok" }),
      ]),
    );
    expect(
      calls.filter((call) =>
        ["handoff", "bash", "listDir", "readFile", "loadSkill"].includes(
          call.name,
        ),
      ),
    ).toEqual([]);
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });
});
