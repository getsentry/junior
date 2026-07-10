import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

const codingFixtureOverrides = {
  skill_dirs: ["fixtures/coding-skills"],
};

describeEval("Coding File Tools", slackEvals, (it) => {
  it("when making a targeted source edit, update the value and report the changed path", async ({
    run,
  }) => {
    await run({
      overrides: codingFixtureOverrides,
      initialEvents: [
        mention(
          "In the eval coding fixture, change the default retry count from 2 to 3. Keep the reply brief and tell me which file changed.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The final reply identifies the changed config file and says the default retry count is now 3.",
        ],
        fail: [
          "Do not answer with only a plan or promise to edit later.",
          "Do not report a file unrelated to the retry-count setting as the changed file.",
        ],
      }),
    });
  });

  it("when comparing fixture behavior, cite the relevant files and leave them unchanged", async ({
    run,
  }) => {
    await run({
      overrides: codingFixtureOverrides,
      initialEvents: [
        mention(
          "In the eval coding fixture, compare project/src/alerts.ts and project/docs/operations.md for emergency mode behavior. Summarize what each file says and do not change any files.",
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
});
