import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals, threadMessage } from "../helpers";

describeEval("GitHub Skill Workflows", slackEvals, (it) => {
  it("when the GitHub credential smoke command runs, return one CREDENTIAL_OK reply", async ({
    run,
  }) => {
    await run({
      overrides: {
        skill_dirs: ["evals/fixtures/skills"],
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-smoke-token",
      },
      events: [mention("/capability-credential-smoke")],
      criteria: rubric({
        contract:
          "The GitHub capability credential smoke command succeeds in one reply.",
        pass: [
          "The assistant posts exactly one reply containing CREDENTIAL_OK.",
          "The configured smoke command is `gh issue view 1 --repo getsentry/junior`; a final `CREDENTIAL_OK` reply is sufficient evidence that it succeeded.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    });
  });

  it("when creating a GitHub issue, skip duplicate-search narration in the reply", async ({
    run,
  }) => {
    await run({
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-github-token",
        skill_dirs: ["../junior/skills"],
      },
      events: [
        mention(
          "Create an issue for adding rate limiting to the API endpoint in getsentry/junior",
        ),
      ],
      criteria: rubric({
        contract:
          "The assistant creates the GitHub issue and reports the result without duplicate-search narration clutter.",
        pass: [
          "The assistant creates the requested GitHub issue and reports the result without narrating unrelated duplicate-search work.",
        ],
        fail: [
          "Do not add duplicate-search narration unless the user asked for duplicate checking.",
        ],
      }),
    });
  });

  const reporterRequesterThread = {
    id: "thread-reporter-requester",
    channel_id: "C-reporter-requester",
    thread_ts: "17000000.reporter-requester",
  };

  it("when one user reports and another files an issue, keep attribution roles separate", async ({
    run,
  }) => {
    await run({
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        subscribed_decisions: [
          {
            should_reply: false,
            reason: "context-setting message only",
          },
        ],
        test_credential_token: "eval-github-attribution-token",
        skill_dirs: ["../junior/skills"],
      },
      events: [
        threadMessage(
          "Warden resolved its own review thread on getsentry/junior-eval-ops-reference-never-exists#20366 even though the warning still applies. The warning was about `SCM_RPC_SHARED_SECRET` not being backported to the cookiecutter template, and the PR still shows `REVIEW_REQUIRED`.",
          {
            thread: reporterRequesterThread,
            author: {
              user_id: "U_BOJAN",
              user_name: "bojan",
              full_name: "Bojan Oro",
            },
          },
        ),
        mention(
          "Create a GitHub issue for this in getsentry/junior-eval-warden-never-exists. Include the issue body you filed in your reply so I can verify attribution.",
          {
            thread: reporterRequesterThread,
            author: {
              user_id: "U_DCRAMER",
              user_name: "dcramer",
              full_name: "David Cramer",
            },
          },
        ),
      ],
      criteria: rubric({
        contract:
          "GitHub issue creation from a multi-user Slack thread preserves the original reporter separately from the action requester.",
        pass: [
          "The reply reports a created GitHub issue in getsentry/junior-eval-warden-never-exists with an issue URL or issue number.",
          "The shown issue content keeps Bojan Oro as the reporter and David Cramer as the action requester.",
        ],
        allow: [
          "Reporter attribution may be phrased as `Reported by Bojan Oro`, `Raised by Bojan Oro`, or equivalent durable issue-body text.",
          "The action-requester footer may be phrased as `Action taken on behalf of David Cramer.` or equivalent durable issue-body text.",
        ],
        fail: [
          "Do not swap the reporter and requester roles.",
          "Do not omit reporter or requester attribution when the prompt asks to show the filed issue content.",
        ],
      }),
    });
  });

  it("when a GitHub task mentions a Sentry product area, do not prompt for Sentry auth first", async ({
    run,
  }) => {
    await run({
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github", "@sentry/junior-sentry"],
        test_credential_token: "eval-routing-token",
        skill_dirs: ["../junior/skills"],
      },
      events: [
        mention(
          "Create a GitHub issue in getsentry/junior about why the Metrics Beta wording can send a code-change request down the wrong auth path.",
        ),
      ],
      criteria: rubric({
        contract:
          "A repository task that happens to mention a Sentry product area still follows the GitHub path instead of asking for unrelated Sentry auth.",
        pass: [
          "The assistant treats the request as GitHub issue work and does not block on unrelated Sentry auth.",
        ],
        fail: [
          "Do not ask the user to connect Sentry or inspect live Sentry data before doing the GitHub task.",
        ],
      }),
    });
  });

  it("when asked an implementation question about this repo, answer from repository evidence", async ({
    run,
  }) => {
    await run({
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-repo-evidence-token",
        skill_dirs: ["../junior/skills"],
      },
      events: [
        mention(
          "In getsentry/junior, where do we resolve GitHub credential injection from the loaded skill for the current turn? Keep it brief and cite the repo file or symbol you checked.",
        ),
      ],
      criteria: rubric({
        contract:
          "An implementation question is answered from repository evidence rather than generic memory or product framing.",
        pass: [
          "The reply cites repository evidence such as a file path, symbol, or nearby contract reference.",
          "The reply explains briefly that credential injection comes from the loaded plugin-backed skill for the current turn.",
        ],
        fail: [
          "Do not answer as if this were a product or UI question.",
          "Do not answer purely from generic GitHub or OAuth knowledge without repo evidence.",
        ],
      }),
    });
  });

  it("when asked about PR auth sequencing, mention push auth before PR auth", async ({
    run,
  }) => {
    await run({
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-pr-auth-order-token",
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
  const defaultRepoIssueThread = {
    id: "thread-default-repo-issue",
    channel_id: "C-default-repo-issue",
    thread_ts: "17000000.default-repo-issue",
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

  it("when creating an issue after repo setup, use the stored repo without inventing tool failures", async ({
    run,
  }) => {
    await run({
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-default-repo-create-token",
        skill_dirs: ["../junior/skills"],
      },
      events: [
        mention("Set the default repo to getsentry/junior for this channel.", {
          thread: defaultRepoIssueThread,
        }),
        threadMessage(
          "Create a GitHub issue for a bug where Slack follow-up replies sometimes blame missing tooling instead of showing the failed command.",
          {
            thread: defaultRepoIssueThread,
            is_mention: true,
          },
        ),
      ],
      criteria: rubric({
        contract:
          "Stored GitHub repo context carries into a later issue-creation workflow, and tool-failure explanations stay grounded in observed command results.",
        pass: [
          "The assistant confirms the default repo setup and later uses getsentry/junior for issue creation without asking again.",
          "The assistant creates or reports a GitHub issue in getsentry/junior.",
          "Any tool-failure explanation is grounded in an observed command result.",
        ],
        fail: [
          "Do not claim that `gh`, the GitHub CLI, or `jr-rpc` is unavailable, missing, or not installed.",
          "Do not ask the user to pass --repo or provide the repo again.",
          "Do not create, target, or report an issue for a repository other than getsentry/junior.",
        ],
      }),
    });
  });

  it("when a default repo is set in one turn, reuse it in the next turn without asking again", async ({
    run,
  }) => {
    await run({
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-default-repo-token",
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
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-target-classification-context-token",
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
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        test_credential_token: "eval-target-classification-explicit-token",
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
