import { describe } from "vitest";
import { mention, slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: GitHub Skill Workflows", () => {
  slackEval("skills: capability credential smoke command", {
    overrides: {
      skill_dirs: ["evals/fixtures/skills"],
      enable_test_credentials: true,
      plugin_packages: ["@sentry/junior-github"],
      test_credential_token: "eval-smoke-token",
    },
    events: [mention("/capability-credential-smoke")],
    criteria:
      "The assistant posts exactly one reply containing CREDENTIAL_OK and does not include sandbox setup failure text.",
  });

  slackEval("skills: github issue create skips dupe narration", {
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
    criteria:
      "The assistant creates a GitHub issue without narrating duplicate-search results. The reply must not mention checking for duplicates, searching for similar issues, or reporting that no duplicates were found. The reply should proceed directly to issue creation and report the result.",
  });

  const defaultRepoThread = {
    id: "thread-default-repo",
    channel_id: "C-default-repo",
    thread_ts: "17000000.default-repo",
  };

  slackEval("skills: default repo setup via natural language", {
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
    criteria:
      "The assistant posts exactly two replies in-order. The first reply confirms default repo setup for getsentry/junior. The second reply enables GitHub issues read credentials using that stored repo context and does not ask to pass --repo again. Neither reply includes sandbox setup failure text.",
  });
});
