/**
 * Cases from getsentry/junior pull requests where a reviewer asked for a
 * better description. Each fixture is the first description the agent wrote,
 * used as the context. The rubric follows the reviewer's feedback and the
 * description that the reviewer accepted.
 */
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { pullRequestDescriptionEvals } from "./harness";

function firstDraft(pullRequest: number): string {
  return readFileSync(
    new URL(`./fixtures/pr-${pullRequest}.md`, import.meta.url),
    "utf8",
  );
}

describeEval(
  "Pull Request Descriptions from reviewed PRs",
  pullRequestDescriptionEvals,
  (it) => {
    // #2420: "simplify the PR title/description so its clear what we're addressing"
    it("when the notes are an investigation report, the description says what was fixed in plain words", async ({
      run,
    }) => {
      const result = await run({
        title: "fix(evals): Fix two flaky behavioral evals",
        context: firstDraft(2420),
        mustInclude: ["#2413"],
        maxChars: 2000,
      });
      await expect(result).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The description says in plain words what changed for each flaky eval: `findMeetingTimes` now says which required attendees blocked every slot, and the delegation eval gets a longer idle limit.",
            "The description keeps the open decision about the deployment watch eval in a few lines.",
          ],
          fail: [
            "The description includes investigation evidence, such as run counts, durations, or replay versus live analysis.",
            "The description lists the checks or commands that ran.",
          ],
        }),
      );
    });

    // #2461: "remove the requirement of a phd to understand what the change is"
    it("when the notes list every changed file, the description explains the problem and the fix instead", async ({
      run,
    }) => {
      const result = await run({
        title:
          "fix(slack): Resolve one Slack target for every visible Turn post",
        context: firstDraft(2461),
        mustInclude: ["#2458"],
        maxChars: 2200,
      });
      await expect(result).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The description starts with the problem in plain words: some Slack posts went to the wrong thread or had no footer, because the Slack thread was guessed from the Conversation id.",
            "The description keeps the merge-order note: merge #2458 first.",
          ],
          fail: [
            "The description lists the changed files one by one.",
            "The description mentions local test failures or the test environment.",
          ],
        }),
      );
    });

    // #2959: "Clean up the PR description here so its more succinct"
    it("when the notes are long, the description keeps each change to a sentence or two", async ({
      run,
    }) => {
      const result = await run({
        title:
          "ref(task-execution): One runnable check and no Conversation status repair",
        context: firstDraft(2959),
        mustInclude: ["#2890", "#2951"],
        maxChars: 1800,
      });
      await expect(result).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The description covers the four changes, each in one or two plain sentences.",
            "The description keeps the note that #2951 also adds migration 0089, so the PR that merges second must renumber its migration.",
          ],
          fail: ["The description lists test files or test results."],
        }),
      );
    });

    // #2442: "far too technical ... doesn't explain what we're actually doing,
    // what the final interface looks like, and what might break"
    it("when the notes are too technical, the description says what changes and what might break", async ({
      run,
    }) => {
      const result = await run({
        title: "feat(events)!: Convert event automation identifiers to filters",
        context: firstDraft(2442),
        mustInclude: ["#2362"],
        maxChars: 2500,
      });
      await expect(result).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The description explains in plain words what changes for event automations: a trigger that names an exact identifier is saved as filters that select the same events, and a trigger never gets broader.",
            "The description says clearly what might change for existing automations and for callers of the update tool.",
          ],
          fail: [
            "The description opens with an internal plan label, such as 'Slice C of item 7', before it says what the change does.",
            "The description lists the checks or test results.",
          ],
        }),
      );
    });

    // #2379: "not clear to me if this is a breaking change as the PR
    // description requires too much context to understand"
    it("when the notes do not lead with impact, the description says whether the change breaks anything", async ({
      run,
    }) => {
      const result = await run({
        title: "ref(events): Declare core event limits per resource type",
        context: firstDraft(2379),
        mustInclude: ["#2362"],
        maxChars: 1800,
      });
      await expect(result).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The description says early and clearly whether this is a breaking change for users, plugins, or saved automations. The notes say behavior stays the same and the published plugin API does not change.",
            "The description says in plain words what changes: core event resource types declare which ones watches and event automations cannot use, instead of core checking namespace strings.",
            "The description keeps the open question that Sentry issue identifiers now need a numeric issue id.",
          ],
          fail: ["The description lists the checks or test results."],
        }),
      );
    });

    // #3204: the requester deleted the paragraph about how the tool got its name.
    it("when the notes explain how a name was chosen, the description leaves that out", async ({
      run,
    }) => {
      const result = await run({
        title:
          "feat(github): Add tools to edit own issue comments and react to issues",
        context: firstDraft(3204),
        mustInclude: [
          "getsentry/junior-prod#669",
          "github_updateIssueComment",
          "github_reactToIssue",
        ],
        mustNotInclude: ["tool-search-ranking"],
        maxChars: 1600,
      });
      await expect(result).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The description says why: label-triggered SDK repro runs need a start reaction and one progress comment, and the egress policy denied both GitHub endpoints.",
          ],
          fail: [
            "The description explains how tool search ranked another name for the reaction tool.",
          ],
        }),
      );
    });

    // #2668: the description kept local test notes and first-person asides.
    it("when the notes include local test runs and first-person asides, the description drops them", async ({
      run,
    }) => {
      const result = await run({
        title: "feat(slack): Show tool progress in the assistant loading state",
        context: firstDraft(2668),
        mustNotInclude: ["Local runs"],
        maxChars: 2200,
      });
      await expect(result).toSatisfyJudge(
        RubricJudge,
        rubric({
          pass: [
            "The description says what users see: the Slack loading state shows the current tool step instead of rotating joke messages.",
            "The description keeps that progress labels never show raw user text, commands, or arguments.",
            "The description keeps the open questions about the 8s phase hold and about file names and hostnames in public channels.",
          ],
          fail: [
            "The description mentions local test runs or failures in the author's environment.",
            "The description uses the first person, such as 'I left it'.",
          ],
        }),
      );
    });
  },
);
