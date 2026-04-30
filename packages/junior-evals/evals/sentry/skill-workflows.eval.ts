import { describe } from "vitest";
import { mention, rubric, slackEval } from "../helpers";

describe("Sentry Skill Workflows", () => {
  slackEval(
    "when the Sentry credential smoke command runs, return one CREDENTIAL_OK reply",
    {
      overrides: {
        skill_dirs: ["evals/fixtures/skills"],
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-sentry"],
        reply_timeout_ms: 90_000,
        test_credential_token: "eval-sentry-token",
      },
      events: [mention("/sentry-credential-smoke")],
      criteria: rubric({
        contract:
          "The Sentry capability credential smoke command succeeds in one reply.",
        pass: [
          "The assistant posts exactly one reply containing CREDENTIAL_OK.",
          "The configured smoke command is `sentry issue list getsentry/ --limit 1`; a final `CREDENTIAL_OK` reply is sufficient evidence that it succeeded.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    },
  );

  slackEval(
    "when listing Sentry organizations, use the current org command surface",
    {
      overrides: {
        enable_test_credentials: true,
        plugin_packages: ["@sentry/junior-sentry"],
        reply_timeout_ms: 90_000,
        test_credential_token: "eval-sentry-token",
      },
      events: [mention("List the Sentry organizations I can access.")],
      criteria: rubric({
        contract:
          "The assistant verifies or uses the current Sentry CLI organization command and reports accessible organizations instead of blocking on a stale command.",
        pass: [
          "Observed bash tool invocations include `sentry org list`.",
          "The assistant reply includes `getsentry` or otherwise reports the accessible organization list from the command result.",
          "The assistant does not claim that organization listing is unavailable.",
        ],
        fail: [
          "Do not call `sentry organizations list`.",
          "Do not say the Sentry org query surface is unavailable.",
          "Do not ask the user to reconnect Sentry unless the command returns an auth failure.",
        ],
      }),
    },
  );
});
