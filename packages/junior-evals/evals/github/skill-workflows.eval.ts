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
        threadMessage(
          "Now enable github issues read credentials without passing --repo.",
          { thread: defaultRepoThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        contract:
          "Stored repo context is reused in a later turn without asking the user to restate the repo.",
        pass: [
          "The assistant posts exactly two replies in order.",
          "The first reply confirms default repo setup for getsentry/junior.",
          "The second reply enables GitHub issues read credentials using that stored repo context.",
        ],
        fail: [
          "Do not ask the user to pass --repo again.",
          "Do not include sandbox setup failure text in either reply.",
        ],
      }),
    },
  );
});
