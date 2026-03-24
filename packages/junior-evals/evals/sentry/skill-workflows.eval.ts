import { describe } from "vitest";
import { mention, slackEval } from "../helpers";

describe("Conversational Evals: Sentry Skill Workflows", () => {
  slackEval("skills: sentry capability credential smoke command", {
    overrides: {
      skill_dirs: ["evals/fixtures/skills"],
      enable_test_credentials: true,
      plugin_packages: ["@sentry/junior-sentry"],
      test_credential_token: "eval-sentry-token",
    },
    events: [mention("/sentry-credential-smoke")],
    criteria:
      "The assistant posts exactly one reply containing CREDENTIAL_OK and does not include sandbox setup failure text.",
  });
});
