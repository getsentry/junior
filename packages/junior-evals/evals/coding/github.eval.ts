import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("GitHub Skill Workflows", () => {
  test("when asked about PR auth sequencing, explain automatic installation credentials", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/github-code If I ask you to open a PR from an existing branch, do I need to authorize GitHub or provide a token? Also, does the branch get pushed before or after the PR is opened? Keep it short.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The answer says the branch is pushed before the pull request is created.",
          "The answer explains that Junior automatically injects the GitHub App credential for the standard push and pull request workflow, with no user-managed token or authorization step.",
        ],
        fail: [
          "Do not tell the user to grant Pull requests: write, authorize GitHub, provide a token, or take another authentication action for this standard bot workflow.",
          "Do not recommend `gh pr create` for new pull requests.",
          "Do not imply that pull request creation credentials alone are sufficient before the push.",
        ],
      }),
    );
  });

  test("when completed code work leaves an optional follow-up, open the PR without asking", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/github-code Say you finished a code change on a pushed branch and the checks pass, but you left out an optional cleanup that would widen the change. Do you ask me before you open the PR, or what do you do? Keep it short.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The answer says Junior opens the pull request without asking first.",
          "The answer says the left-out cleanup is named as a follow-up, such as in the pull request body or the report.",
        ],
        fail: [
          "Do not say Junior asks the user whether to open the pull request or waits for permission.",
          "Do not say Junior adds the cleanup to the change before opening the pull request.",
        ],
      }),
    );
  });

  test("when writing a PR body, say what changed and why without explaining how", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/github-code Draft the PR body for this change, don't open anything. The setup runbook pipes our CLI installer into bash, and the installer is served from a CDN. The change makes the runbook download the installer to a temp file, hash it with sha256sum (or shasum on macOS), and run it only when the hash matches the checksum in the release registry. It reads the checksum from a Redis cache, rechecks it at most once a minute with a 3s timeout, and keeps the old pipe-to-bash command when no checksum is published. I added 6 tests and ran shellcheck.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The body says the runbook checks the installer against the published checksum before it runs it.",
          "The body says why: a tampered installer from the CDN would otherwise run.",
        ],
        fail: [
          "Do not use headings or more than two short paragraphs in the body.",
          "Do not explain how the code works, such as the cache, the recheck interval, the timeout, the temp file, or the hash commands.",
          "Do not describe tests, shellcheck, or other checks in the body.",
        ],
      }),
    );
  });

  test("when CI stalls with no cause in the logs, check GitHub status before blaming an outage", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/github-code Say the checks on my PR sat queued for 40 minutes, then a job failed with nothing useful in the logs. What do you do first? Keep it short.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The answer says Junior checks GitHub status (githubstatus.com) for an open or recent incident.",
          "The answer says Junior reports a related incident as the likely cause, and does not blame an outage when there is no related incident.",
        ],
        fail: [
          "Do not say the failure is an outage without checking GitHub status.",
          "Do not tell the user to check GitHub status themselves.",
        ],
      }),
    );
  });

  test("when a default repo is set in one turn, reuse it in the next turn without asking again", async ({
    run,
  }) => {
    const configured = await run(
      slackMention(
        "Set the default repo to getsentry/junior for this channel.",
      ),
    );
    await expect(configured).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant confirms that the default repo for this channel is getsentry/junior.",
        ],
      }),
    );
    // Junior stores an explicit default without an agent turn.
    expect(configured.turns).toEqual([]);
    const conversation = await configured.continue(
      slackMention(
        "Now tell me which GitHub repo you'd use for issue commands when I don't name one.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant says issue commands without an explicit repo would use getsentry/junior.",
        ],
        fail: [
          "Do not ask the user to provide the repo again.",
          "Do not say a live GitHub lookup is required before answering.",
        ],
      }),
    );
  });

  test("when drafting an issue from a foreign reference, keep the default repo as target", async ({
    run,
  }) => {
    const configured = await run(
      slackMention(
        "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel.",
      ),
    );
    const conversation = await configured.continue(
      slackMention(
        "We need a tracking issue for the Junior bot. Use getsentry/junior-eval-reference-never-exists#123 as background. Draft the target repo, title, and body for me to review—don't create anything yet.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant drafts the requested issue against getsentry/junior-eval-bot-never-exists.",
          "The foreign issue reference is treated only as context if it appears in the answer.",
          "No GitHub issue is created for this draft-only request.",
        ],
        fail: [
          "Do not choose getsentry/junior-eval-reference-never-exists as the action target.",
          "Do not create or comment on a GitHub issue for either fake repo.",
          "Do not ask the user to provide the repo again.",
        ],
      }),
    );
  });

  test("when confirming an explicit issue reference, use that issue as target", async ({
    run,
  }) => {
    const configured = await run(
      slackMention(
        "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel.",
      ),
    );
    const conversation = await configured.continue(
      slackMention(
        "Before I approve a later comment, confirm the target issue for getsentry/junior-eval-reference-never-exists#123. Don't change anything yet.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant recognizes the explicitly referenced issue as the action target.",
          "No GitHub issue is created or commented on for this confirmation-only request.",
        ],
        fail: [
          "Do not choose getsentry/junior-eval-bot-never-exists as the action target.",
          "Do not create or comment on a GitHub issue for either fake repo.",
          "Do not ask the user to restate the repository or issue number.",
        ],
      }),
    );
  });
});
