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
      taskTimeout: 120_000,
      criteria: rubric({
        contract:
          "A small source edit in the sandbox fixture uses precise file editing instead of full-file rewrites or shell mutation.",
        pass: [
          "observed_tool_invocations includes `editFile`.",
          "observed_tool_invocations includes at least one inspection tool before or alongside the edit, such as `readFile`, `grep`, `findFiles`, or `listDir`.",
          "observed_tool_invocations does not include `writeFile`.",
          "A first-class `grep` tool invocation is acceptable; the forbidden case is an invocation with `tool` set to `bash` and `bash_command` containing discovery or edit commands such as `ls`, `find`, `grep`, `cat`, `sed`, `perl`, `python`, `tee`, or shell redirection.",
          "assistant_posts contains exactly one final reply.",
          "The reply names the edited config file; acceptable paths include `src/config.ts`, `project/src/config.ts`, or `skills/coding-workspace-fixture/project/src/config.ts`.",
          "The reply says the default retry count is now 3.",
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
      taskTimeout: 120_000,
      criteria: rubric({
        contract:
          "A sandbox fixture discovery task uses structured file discovery/read tools and returns grounded file-path evidence without modifying files.",
        pass: [
          "observed_tool_invocations includes `grep` or `findFiles`.",
          "observed_tool_invocations includes `readFile` or `listDir`.",
          "observed_tool_invocations does not include `editFile` or `writeFile`.",
          "A first-class `grep` tool invocation is acceptable; the forbidden case is an invocation with `tool` set to `bash` and `bash_command` containing discovery commands such as `ls`, `find`, `grep`, or `cat`.",
          "assistant_posts contains exactly one final reply.",
          "The reply mentions `project/src/alerts.ts` or `skills/coding-workspace-fixture/project/src/alerts.ts`.",
          "The reply mentions `project/docs/operations.md` or `skills/coding-workspace-fixture/project/docs/operations.md`.",
          "The reply accurately summarizes that source code handles emergency alerts while the operations doc describes escalation or operator behavior.",
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
