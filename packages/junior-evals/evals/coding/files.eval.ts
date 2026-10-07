import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Coding File Tools", () => {
  test("when asked about a workspace image, inspect it and explain what it shows", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/coding-workspace-fixture What's in project/assets/workspace-shapes.png? Describe the colored shapes and where they are.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says the image contains a blue square on the left, a red circle on the right, and a green triangle near the bottom center.",
          "The reply is based on inspecting the image rather than guessing from its filename.",
        ],
        fail: [
          "Do not claim the image cannot be viewed or ask the user to upload it again.",
          "Do not describe different colors, shapes, or positions as the main image contents.",
        ],
      }),
    );

    expect(
      completedToolCalls("viewImage", conversation).map((call) => call.input),
    ).toContainEqual({
      path: expect.stringContaining("project/assets/workspace-shapes.png"),
    });
  });

  test("when making a targeted source edit, update the value and report the changed path", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/coding-workspace-fixture Change the default retry count from 2 to 3. Keep the reply brief and tell me which file changed.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The final reply identifies project/src/config.ts and says the default retry count is now 3.",
        ],
        fail: [
          "Do not answer with only a plan or promise to edit later.",
          "Do not report a file unrelated to the retry-count setting as the changed file.",
        ],
      }),
    );

    expect(
      ["bash", "editFile", "writeFile"]
        .flatMap((name) => completedToolCalls(name, conversation))
        .filter((call) =>
          JSON.stringify(call.input).includes("project/src/config.ts"),
        ),
    ).not.toHaveLength(0);
  });

  test("when comparing fixture behavior, cite the relevant files and leave them unchanged", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/coding-workspace-fixture Compare project/src/alerts.ts and project/docs/operations.md for emergency mode behavior. Summarize what each file says and do not change any files.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply cites the alert source file and the operations doc using recognizable fixture-relative paths.",
          "The reply accurately summarizes that source code handles emergency alerts while the operations doc describes escalation or operator behavior.",
          "The reply does not claim that any fixture files were modified.",
        ],
        fail: [
          "Do not say that files were changed for this read-only request.",
          "Do not answer with generic emergency-mode advice instead of fixture file evidence.",
          "Do not report unrelated files as the only evidence.",
        ],
      }),
    );
  });

  test("when a coding request requires architecture reasoning, give a concrete recommendation", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "I have a TypeScript worker where config.ts defines emergencyMode, but alerts.ts currently receives a mode argument independently. Before we implement anything, recommend whether alerts should import runtime config directly or keep mode as an explicit dependency, and give me the test strategy. I'm looking for a design recommendation first, not a repository review.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply makes a concrete recommendation about direct config access versus explicit dependency injection.",
          "The reply explains the architectural tradeoff and gives a focused test strategy.",
        ],
        fail: [
          "Do not claim repository files were inspected or changed.",
          "Do not answer with only a promise to analyze later.",
        ],
      }),
    );
  });
});
