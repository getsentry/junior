import { describe } from "vitest";
import { mention, rubric, slackEval, threadMessage } from "../helpers";

describe("GitHub Skill Workflows", () => {
  slackEval(
    "when the GitHub credential smoke command runs, return one CREDENTIAL_OK reply",
    {
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
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    },
  );

  slackEval(
    "when creating a GitHub issue, skip duplicate-search narration in the reply",
    {
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        reply_timeout_ms: 75000,
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
          "The reply proceeds directly to issue creation and reports the result.",
        ],
        fail: [
          "Do not mention checking for duplicates.",
          "Do not mention searching for similar issues.",
          "Do not report that no duplicates were found.",
        ],
      }),
    },
  );

  const reporterRequesterThread = {
    id: "thread-reporter-requester",
    channel_id: "C-reporter-requester",
    thread_ts: "17000000.reporter-requester",
  };

  slackEval(
    "when one user reports and another files an issue, keep attribution roles separate",
    {
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        reply_timeout_ms: 90_000,
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
          "Warden resolved its own review thread on https://github.com/getsentry/ops/pull/20366 even though the warning still applies. The warning was about `SCM_RPC_SHARED_SECRET` not being backported to the cookiecutter template, and the PR still shows `REVIEW_REQUIRED`.",
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
          "Create a GitHub issue for this in getsentry/warden. Include the issue body you filed in your reply so I can verify attribution.",
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
          "The assistant posts exactly one reply.",
          "The reply reports a created GitHub issue in getsentry/warden with an issue URL or issue number.",
          "The reply includes the filed issue body or enough quoted issue content to verify attribution.",
          "The shown issue content attributes the report to Bojan Oro.",
          "The shown issue content ends its delegated-action footer with `Action taken on behalf of David Cramer.`",
        ],
        allow: [
          "Reporter attribution may be phrased as `Reported by Bojan Oro`, `Raised by Bojan Oro`, or equivalent durable issue-body text.",
        ],
        fail: [
          "Do not use `Action taken on behalf of Bojan Oro.`",
          "Do not describe David Cramer as the reporter.",
          "Do not omit reporter attribution when showing the filed issue content.",
        ],
      }),
    },
  );

  slackEval(
    "when a GitHub task mentions a Sentry product area, do not prompt for Sentry auth first",
    {
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github", "@sentry/junior-sentry"],
        reply_timeout_ms: 75_000,
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
          "The reply reports a GitHub issue result or otherwise proceeds as GitHub issue work.",
          "The reply does not ask the user to connect a Sentry account first.",
        ],
        fail: [
          "Do not say you need to connect Sentry first.",
          "Do not mention sending a Sentry authorization link.",
          "Do not ask to inspect live Sentry data before doing the GitHub task.",
        ],
      }),
    },
  );

  slackEval(
    "when asked an implementation question about this repo, answer from repository evidence",
    {
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        reply_timeout_ms: 90_000,
        test_credential_token: "eval-repo-evidence-token",
        skill_dirs: ["../junior/skills"],
      },
      events: [
        mention(
          "In this repo, where do we resolve GitHub credential injection from the loaded skill for the current turn? Keep it brief and cite the repo file or symbol you checked.",
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
    },
  );

  slackEval(
    "when asked about PR auth sequencing, mention push auth before PR auth",
    {
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        reply_timeout_ms: 60_000,
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
    },
  );

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

  slackEval(
    "when creating an issue after repo setup, use the stored repo without inventing tool failures",
    {
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-github"],
        reply_timeout_ms: 75_000,
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
          "The assistant posts exactly two replies in order.",
          "observed_tool_invocations includes a `loadSkill` invocation with `skill_name` set to `github-issues` before issue creation.",
          "observed_tool_invocations includes a bash invocation that stores or uses `github.repo` as getsentry/junior.",
          "observed_tool_invocations includes a bash invocation with `gh issue create` scoped to `--repo getsentry/junior`.",
          "The first reply confirms default repo setup for getsentry/junior.",
          "The second reply reports a created GitHub issue in getsentry/junior with an issue URL or issue number.",
          "The second reply does not ask the user to restate the repository.",
        ],
        fail: [
          "Do not claim that `gh`, the GitHub CLI, or `jr-rpc` is unavailable, missing, or not installed.",
          "Do not blame issue creation on a missing tool without quoting an observed command failure.",
          "Do not ask the user to pass --repo or provide the repo again.",
          "Do not create or report an issue for a repository other than getsentry/junior.",
        ],
      }),
    },
  );

  slackEval(
    "when a default repo is set in one turn, reuse it in the next turn without asking again",
    {
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
        threadMessage("Now list GitHub issues without passing --repo.", {
          thread: defaultRepoThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        contract:
          "Stored repo context is reused in a later turn without asking the user to restate the repo.",
        pass: [
          "The assistant posts exactly two replies in order.",
          "The first reply confirms default repo setup for getsentry/junior.",
          "The second reply clearly reuses getsentry/junior as stored repo context without asking for the repo again.",
        ],
        allow: [
          "A concise note that the runtime could not finish the GitHub command is acceptable if the reply still clearly reuses the stored repo context instead of asking the user to restate it.",
        ],
        fail: [
          "Do not ask the user to pass --repo again.",
          "Do not claim there is a separate credential-enable config the user needs to set first.",
        ],
      }),
    },
  );
});
