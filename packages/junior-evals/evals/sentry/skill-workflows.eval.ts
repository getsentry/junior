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
        test_credential_token: "eval-sentry-token",
      },
      events: [mention("/sentry-credential-smoke")],
      criteria: rubric({
        contract:
          "The Sentry capability credential smoke command succeeds in one reply.",
        pass: [
          "The assistant posts exactly one reply containing CREDENTIAL_OK.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    },
  );
});
