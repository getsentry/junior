import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../helpers";

const codingFixtureOverrides = {
  skill_dirs: ["evals/fixtures/coding-skills"],
};

describeEval("Coding File Tools", slackEvals, (it) => {
  it("when making a targeted source edit, use precise edit tooling and report the changed path", async ({
    run,
  }) => {
    await run({
      overrides: codingFixtureOverrides,
      events: [
        mention(
          "In the eval coding fixture, change the default retry count from 2 to 3. Keep the reply brief and tell me which file changed.",
        ),
      ],
      criteria: rubric({
        contract:
          "A small source edit in the sandbox fixture uses precise file editing instead of full-file rewrites or shell mutation.",
        pass: [
          "The assistant inspects the fixture before editing and uses precise edit tooling for the retry-count change.",
          "The assistant does not use full-file rewrites or shell mutation for this targeted edit.",
          "The final reply identifies the changed config file and says the default retry count is now 3.",
        ],
        fail: [
          "Do not claim the file was changed without an observed `editFile` invocation.",
          "Do not use `writeFile` for this targeted edit.",
          "Do not answer with only a plan or promise to edit later.",
        ],
      }),
    });
  });

  it("when locating fixture behavior, use structured discovery and leave files unchanged", async ({
    run,
  }) => {
    await run({
      overrides: codingFixtureOverrides,
      events: [
        mention(
          "In the eval coding fixture, find where emergency mode is handled or documented. Summarize the relevant file paths and what each one says. Do not change any files.",
        ),
      ],
      criteria: rubric({
        contract:
          "A sandbox fixture discovery task uses structured file discovery/read tools and returns grounded file-path evidence without modifying files.",
        pass: [
          "The assistant uses structured file discovery/read tools to inspect the fixture.",
          "The reply cites the alert source file and the operations doc using recognizable fixture-relative paths.",
          "The reply accurately summarizes that source code handles emergency alerts while the operations doc describes escalation or operator behavior.",
          "No fixture files are modified.",
        ],
        fail: [
          "Do not modify files for this read-only request.",
          "Do not answer from memory without observed file discovery or reads.",
          "Do not report unrelated files as the only evidence.",
        ],
      }),
    });
  });
});
