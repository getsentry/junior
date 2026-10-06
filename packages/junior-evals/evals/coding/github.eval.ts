import { describe } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("GitHub Skill Workflows", () => {
  test("when asked about PR auth sequencing, explain automatic installation credentials", async ({
    run,
  }) => {
    await run(
      mention(
        "/github-code If I ask you to open a PR from an existing branch, do I need to authorize GitHub or provide a token? Also, does the branch get pushed before or after the PR is opened? Keep it short.",
      ),
      {
        criteria: rubric({
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
      },
    );
  });

  test("when a default repo is set in one turn, reuse it in the next turn without asking again", async ({
    run,
  }) => {
    const configured = await run(
      mention("Set the default repo to getsentry/junior for this channel."),
      {
        criteria: rubric({
          pass: [
            "The assistant confirms that the default repo for this channel is getsentry/junior.",
          ],
        }),
      },
    );
    await configured.continue(
      mention(
        "Now tell me which GitHub repo you'd use for issue commands when I don't name one.",
      ),
      {
        criteria: rubric({
          pass: [
            "The assistant says issue commands without an explicit repo would use getsentry/junior.",
          ],
          fail: [
            "Do not ask the user to provide the repo again.",
            "Do not say a live GitHub lookup is required before answering.",
          ],
        }),
      },
    );
  });

  test("when drafting an issue from a foreign reference, keep the default repo as target", async ({
    run,
  }) => {
    const configured = await run(
      mention(
        "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel.",
      ),
    );
    await configured.continue(
      mention(
        "We need a tracking issue for the Junior bot. Use getsentry/junior-eval-reference-never-exists#123 as background. Draft the target repo, title, and body for me to review—don't create anything yet.",
      ),
      {
        criteria: rubric({
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
      },
    );
  });

  test("when confirming an explicit issue reference, use that issue as target", async ({
    run,
  }) => {
    const configured = await run(
      mention(
        "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel.",
      ),
    );
    await configured.continue(
      mention(
        "Before I approve a later comment, confirm the target issue for getsentry/junior-eval-reference-never-exists#123. Don't change anything yet.",
      ),
      {
        criteria: rubric({
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
      },
    );
  });
});
