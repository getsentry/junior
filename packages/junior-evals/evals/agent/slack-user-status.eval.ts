import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Slack User Status", () => {
  test("when no custom status is set, report that it is unset", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("Am I marked out of office in Slack right now?"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant clearly says the user does not currently have a custom Slack status set.",
        ],
        fail: [
          "Do not claim that Junior's Slack user lookup tool omits status fields or cannot read Slack status.",
          "Do not claim that a users.profile:read scope or connector configuration change is required.",
        ],
      }),
    );

    // `U0TEST` is the default Slack person of the fixture.
    expect(
      completedToolCalls("userLookup", conversation).map((call) => call.input),
    ).toContainEqual({ provider: "slack", query: "U0TEST" });
  });
});
