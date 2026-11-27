import {
  PluginToolInputError,
  type PluginDecider,
} from "@sentry/junior-plugin-api";

// Reviewers read the description before the diff. Each check comes from
// reviewer pushback on agent-written descriptions in getsentry/junior. A
// classifier with no reasoning answers one plain fact well, so each question
// asks one thing. A "yes" rejects the body, and the fix tells the agent what
// to send instead.
const MISSING_REASON_FIX = "Say why the change is needed.";

// Update PULL_REQUEST_BODY_RULES along with these checks.
const DESCRIPTION_CHECKS = [
  {
    question:
      "Does the description report how tests, lint, typecheck, or CI went on this change when the author ran them, passing or failing, locally or in CI, or describe a test plan or test coverage, including what has no tests? Text about what the product does with such commands does not count. Evidence of the failure that the change fixes, such as failed runs before the change, how often a flaky test failed, or a reproduction of the bug, does not count.",
    // Name what to keep: told only to remove check results, agents also cut
    // the failing runs that say why a test or CI fix is needed.
    fix: "Remove how your own runs of tests, lint, or CI on this change went, and test plans or coverage notes. Reviewers see checks on the pull request. Keep the evidence of the failure that the change fixes.",
  },
  {
    question:
      "Does the description narrate the author's own work session, such as what the author investigated, approaches or names the author tried first and dropped, or how many runs the author looked at? Old behavior compared with new behavior does not count.",
    fix: "Remove the work log. Describe the change as it is now.",
  },
  {
    question:
      "Does the description mention the request for this pull request, such as who asked for it or a chat message about it? A product feature that involves Slack or chat does not count.",
    fix: "Remove the conversation. The runtime adds who asked.",
  },
  {
    question:
      "Does the description leave out why the change is needed or what problem it fixes?",
    fix: MISSING_REASON_FIX,
  },
] as const;

/**
 * The `DESCRIPTION_CHECKS` rules, for the `body` param of the pull request
 * tools, so the first draft can pass without a rejection.
 */
export const PULL_REQUEST_BODY_RULES =
  "Say what changes and why. Omit your test or CI runs of the change, test plans, coverage, work logs, and the chat behind it. Failed runs it fixes and what test tools check are fine. The runtime appends attribution and footer.";

/** List the fixes that a pull request description needs. Empty means it passes. */
export async function pullRequestDescriptionFixes(
  decider: PluginDecider,
  body: string,
): Promise<string[]> {
  // A blank body says nothing, so it cannot say why. Do not let a retry with
  // an empty body skip the checks.
  if (!body.trim()) {
    return [MISSING_REASON_FIX];
  }
  const answers = await Promise.all(
    DESCRIPTION_CHECKS.map(({ question }) =>
      decider.decide({
        criteria: { no: "No.", yes: "Yes." },
        instructions: `Judge this GitHub pull request description. ${question}`,
        state: body,
      }),
    ),
  );
  return DESCRIPTION_CHECKS.filter(
    (_, index) => answers[index]!.choice === "yes",
  ).map(({ fix }) => fix);
}

/**
 * Reject a pull request description that has what reviewers do not need.
 * The agent gets the reasons as a tool input error and sends a better body.
 */
export async function checkPullRequestDescription(
  decider: PluginDecider,
  body: string,
): Promise<void> {
  const fixes = await pullRequestDescriptionFixes(decider, body);
  if (fixes.length > 0) {
    throw new PluginToolInputError(
      [
        "Pull request description rejected. Fix it and call the tool again:",
        ...fixes.map((fix) => `- ${fix}`),
        "Write for a reviewer with no context: what changes and why, whether anything breaks and what to do, linked issues, and open questions. Keep it short.",
      ].join("\n"),
    );
  }
}
