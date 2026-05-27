import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals, threadMessage } from "../helpers";

describeEval("GitHub Skill Workflows", slackEvals, (it) => {
  it("when asked about PR auth sequencing, mention push auth before PR auth", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      events: [
        mention(
          "Before you open a GitHub pull request from an existing branch, what credentials do you need and in what order? Keep it short.",
        ),
      ],
      criteria: rubric({
        contract:
          "The assistant explains the GitHub PR auth order without omitting the push step.",
        pass: [
          "The answer explicitly says the branch push happens before `gh pr create` for the PR step.",
          "The answer says the push step needs GitHub write access for the remote.",
        ],
        fail: [
          "Do not imply that PR creation auth alone is sufficient before the push.",
          "Do not omit the explicit push-auth step.",
        ],
      }),
    });
  });

  const defaultRepoThread = {
    id: "thread-default-repo",
    channel_id: "C-default-repo",
    thread_ts: "17000000.default-repo",
  };
  const targetClassificationContextThread = {
    id: "thread-target-classification-context",
    channel_id: "C-target-classification-context",
    thread_ts: "17000000.target-classification-context",
  };
  const targetClassificationExplicitThread = {
    id: "thread-target-classification-explicit",
    channel_id: "C-target-classification-explicit",
    thread_ts: "17000000.target-classification-explicit",
  };

  it("when a default repo is set in one turn, reuse it in the next turn without asking again", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      events: [
        mention("Set the default repo to getsentry/junior for this channel.", {
          thread: defaultRepoThread,
        }),
        threadMessage(
          "Now tell me which GitHub repo you'd use for issue commands when I omit --repo.",
          {
            thread: defaultRepoThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        contract:
          "Stored repo context is reused in a later turn without asking the user to restate the repo.",
        pass: [
          "The assistant confirms default repo setup and later says issue commands without an explicit repo would use getsentry/junior.",
        ],
        allow: [
          "A concise answer is acceptable; no live GitHub issue lookup is required for this continuity check.",
        ],
        fail: [
          "Do not ask the user to provide the repo again.",
          "Do not say a live GitHub lookup is required before answering.",
        ],
      }),
    });
  });

  it("when drafting a fake issue from contextual foreign reference, keep the default repo as target", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      events: [
        threadMessage(
          "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel. Do not verify it exists.",
          {
            thread: targetClassificationContextThread,
            is_mention: true,
          },
        ),
        threadMessage(
          "We need a tracking issue for the Junior bot. This example from getsentry/junior-eval-reference-never-exists#123 shows GitHub issue references can be mistaken for the target repo. Draft the issue I should approve with target repo, title, and body. Do not run GitHub commands.",
          {
            thread: targetClassificationContextThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        contract:
          "Draft a fake issue against the default repo while keeping the fake foreign issue reference as context.",
        pass: [
          "The assistant confirms default repo setup and drafts the requested issue against getsentry/junior-eval-bot-never-exists.",
          "The foreign issue reference is treated only as context if it appears in the answer.",
          "No GitHub issue create/comment/view command is run for this draft-only request.",
        ],
        fail: [
          "Do not choose getsentry/junior-eval-reference-never-exists as the action target.",
          "Do not run GitHub commands against either fake repo.",
          "Do not ask the user to provide the repo again.",
        ],
      }),
    });
  });

  it("when confirming a fake explicit issue reference, use that issue as target", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      events: [
        threadMessage(
          "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel. Do not verify it exists.",
          {
            thread: targetClassificationExplicitThread,
            is_mention: true,
          },
        ),
        threadMessage(
          "Before I approve a later comment, confirm the target issue for getsentry/junior-eval-reference-never-exists#123. Do not run GitHub commands.",
          {
            thread: targetClassificationExplicitThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        contract:
          "Confirm the explicitly referenced issue as target even when a default repo is set.",
        pass: [
          "After confirming default repo setup, the assistant recognizes the explicitly referenced issue as the action target.",
          "No GitHub issue create/comment/view command is run for this confirmation-only request.",
        ],
        fail: [
          "Do not choose getsentry/junior-eval-bot-never-exists as the action target.",
          "Do not run GitHub commands against either fake repo.",
          "Do not ask the user to restate the repository or issue number.",
        ],
      }),
    });
  });
});
