/**
 * Isolated harness for the decision-model checks that the GitHub PR tools run
 * on a pull request description before they write it.
 *
 * Calls the real `pullRequestDescriptionFixes` with the decision model that
 * the GitHub plugin gets. It does not run the agent, GitHub, Postgres, or
 * Redis.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { botConfig } from "@/chat/config";
import { createPluginDecider } from "@/chat/plugins/model";
import { pullRequestDescriptionFixes } from "../../junior-github/src/tool-support/pull-request-description";

interface PullRequestDescriptionCheckInput {
  body: string;
  /** False: the body passes. A list: words from each fix it must get. */
  reject: false | string[];
}

interface PullRequestDescriptionCheckOutput extends Record<string, JsonValue> {
  fixes: string[];
}

/** Lightweight vitest-evals harness for PR description check cases. */
export const pullRequestDescriptionCheckHarness = createHarness<
  PullRequestDescriptionCheckInput,
  PullRequestDescriptionCheckOutput
>({
  name: "pull-request-description-check",
  run: async ({ input }) => {
    const fixes = await pullRequestDescriptionFixes(
      createPluginDecider("github"),
      input.body,
    );
    const problems =
      input.reject === false
        ? fixes.map((fix) => `rejected a good body: ${fix}`)
        : input.reject
            .filter((words) => !fixes.some((fix) => fix.includes(words)))
            .map((words) => `missed "${words}"`);
    if (problems.length > 0) {
      throw new Error(
        `Description check ${problems.join("; ")}. Fixes: ${fixes.join(" | ") || "none"}`,
      );
    }
    return {
      output: { fixes },
      events: [
        { type: "message", role: "user", content: input.body },
        {
          type: "message",
          role: "assistant",
          content: fixes.join("\n") || "pass",
        },
      ],
      usage: {
        provider: "vercel-ai-gateway",
        model: botConfig.decisionModelId,
      },
    };
  },
});

/** Shared vitest-evals suite options for PR description check evals. */
export const pullRequestDescriptionCheckEvals = {
  harness: pullRequestDescriptionCheckHarness,
  // The harness checks the exact fixes; no rubric judge.
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  PullRequestDescriptionCheckInput,
  PullRequestDescriptionCheckOutput,
  typeof pullRequestDescriptionCheckHarness
>;
