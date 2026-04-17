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
