import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../src/helpers";

const codingFixtureOverrides = {
  skill_dirs: ["fixtures/coding-skills"],
};

const imageFixtureOverrides = {
  view_image_files: [
    {
      source: "fixtures/images/workspace-shapes.png",
      path: "/vercel/sandbox/fixtures/workspace-shapes.png",
    },
  ],
};

describeEval("Coding File Tools", slackEvals, (it) => {
  it("when asked about a workspace image, inspect it and explain what it shows", async ({
    run,
  }) => {
    const result = await run({
      overrides: imageFixtureOverrides,
      initialEvents: [
        mention(
          "What's in /vercel/sandbox/fixtures/workspace-shapes.png? Describe the colored shapes and where they are.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply says the image contains a blue square on the left, a red circle on the right, and a green triangle near the bottom center.",
          "The reply is based on inspecting the image rather than guessing from its filename.",
        ],
        fail: [
          "Do not claim the image cannot be viewed or ask the user to upload it again.",
          "Do not describe different colors, shapes, or positions as the main image contents.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toContainEqual(
      expect.objectContaining({
        name: "viewImage",
        status: "ok",
        arguments: expect.objectContaining({
          path: expect.stringContaining("fixtures/workspace-shapes.png"),
        }),
      }),
    );
  });

  it("when making a targeted source edit, update the value and report the changed path", async ({
    run,
  }) => {
    const result = await run({
      overrides: codingFixtureOverrides,
      initialEvents: [
        mention(
          "/coding-workspace-fixture Change the default retry count from 2 to 3. Keep the reply brief and tell me which file changed.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The final reply identifies project/src/config.ts and says the default retry count is now 3.",
        ],
        fail: [
          "Do not answer with only a plan or promise to edit later.",
          "Do not report a file unrelated to the retry-count setting as the changed file.",
        ],
      }),
    });

    expect(
      toolCalls(result.session).some(
        (call) =>
          call.status === "ok" &&
          (call.name === "bash" ||
            call.name === "editFile" ||
            call.name === "writeFile") &&
          JSON.stringify(call.arguments).includes("project/src/config.ts"),
      ),
    ).toBe(true);
  });

  it("when comparing fixture behavior, cite the relevant files and leave them unchanged", async ({
    run,
  }) => {
    await run({
      overrides: codingFixtureOverrides,
      initialEvents: [
        mention(
          "/coding-workspace-fixture Compare project/src/alerts.ts and project/docs/operations.md for emergency mode behavior. Summarize what each file says and do not change any files.",
        ),
      ],
      criteria: rubric({
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
    });
  });

  it("when a coding request requires architecture reasoning, give a concrete recommendation", async ({
    run,
  }) => {
    await run({
      initialEvents: [
        mention(
          "I have a TypeScript worker where config.ts defines emergencyMode, but alerts.ts currently receives a mode argument independently. Before we implement anything, recommend whether alerts should import runtime config directly or keep mode as an explicit dependency, and give me the test strategy. I'm looking for a design recommendation first, not a repository review.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply makes a concrete recommendation about direct config access versus explicit dependency injection.",
          "The reply explains the architectural tradeoff and gives a focused test strategy.",
        ],
        fail: [
          "Do not claim repository files were inspected or changed.",
          "Do not answer with only a promise to analyze later.",
        ],
      }),
    });
  });
});
