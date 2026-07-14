import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  resourceEventNotification,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

describeEval("GitHub Skill Workflows", slackEvals, (it) => {
  it("when subscribed PR checks fail headlessly, commit and push the fix", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        skill_dirs: ["fixtures/github-headless-skills"],
      },
      initialEvents: [
        resourceEventNotification({
          eventType: "checks.failed",
          intent:
            "Fix failing checks on this pull request and push the update.",
          label: "Fixture PR #42",
          resourceRef: "github:pull:local/headless-fixture#42",
          trustedSummary:
            'The build expects skills/github-headless-pr-fixture/project/src/status.ts to export buildStatus = "fixed". Apply the fix, commit it, push the pull request branch, and verify the result.',
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant handles the subscribed event without asking a human to authorize GitHub.",
          "The fixture status is changed from broken to fixed, committed, and pushed to the existing pull request branch.",
          "The assistant reports that the remote branch contains the pushed fix.",
        ],
        fail: [
          "Do not ask for OAuth, a personal access token, approval, or another human action before fixing the subscribed pull request.",
          "Do not stop after describing a plan or editing the file without committing and pushing it.",
          "Do not contact production GitHub or use a non-local remote.",
        ],
      }),
    });

    const verifyCall = toolCalls(result.session).find(
      (call) =>
        call.name === "bash" &&
        JSON.stringify(call.result)?.includes(
          "verified remote branch contains the pushed fix",
        ) === true,
    );
    expect(verifyCall).toMatchObject({ result: { ok: true } });
  });

  it("when asked about PR auth sequencing, explain automatic installation credentials", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      initialEvents: [
        mention(
          "Before you open a GitHub pull request from an existing branch, what credentials do you need and in what order? Keep it short.",
        ),
      ],
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
    });
  });

  const defaultRepoThread = {
    id: "thread-default-repo",
    channel_id: "CDEFAULTREPO",
    thread_ts: "17000000.1401",
  };
  const targetClassificationContextThread = {
    id: "thread-target-classification-context",
    channel_id: "CTARGETCLASSIFICATIONCONTEXT",
    thread_ts: "17000000.1402",
  };
  const targetClassificationExplicitThread = {
    id: "thread-target-classification-explicit",
    channel_id: "CTARGETCLASSIFICATIONEXPLICIT",
    thread_ts: "17000000.1403",
  };

  it("when a default repo is set in one turn, reuse it in the next turn without asking again", async ({
    run,
  }) => {
    await run({
      overrides: {
        plugin_packages: ["@sentry/junior-github"],
        skill_dirs: ["../junior/skills"],
      },
      initialEvents: [
        mention("Set the default repo to getsentry/junior for this channel.", {
          thread: defaultRepoThread,
        }),
      ],
      events: [
        threadMessage(
          "Now tell me which GitHub repo you'd use for issue commands when I omit --repo.",
          {
            thread: defaultRepoThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant confirms default repo setup and later says issue commands without an explicit repo would use getsentry/junior.",
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
      initialEvents: [
        threadMessage(
          "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel. Do not verify it exists.",
          {
            thread: targetClassificationContextThread,
            is_mention: true,
          },
        ),
      ],
      events: [
        threadMessage(
          "We need a tracking issue for the Junior bot. This example from getsentry/junior-eval-reference-never-exists#123 shows GitHub issue references can be mistaken for the target repo. Draft the issue I should approve with target repo, title, and body. Do not run GitHub commands.",
          {
            thread: targetClassificationContextThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
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
      initialEvents: [
        threadMessage(
          "Set the default repo to getsentry/junior-eval-bot-never-exists for this channel. Do not verify it exists.",
          {
            thread: targetClassificationExplicitThread,
            is_mention: true,
          },
        ),
      ],
      events: [
        threadMessage(
          "Before I approve a later comment, confirm the target issue for getsentry/junior-eval-reference-never-exists#123. Do not run GitHub commands.",
          {
            thread: targetClassificationExplicitThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
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
