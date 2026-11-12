import {
  PluginToolInputError,
  type PluginDecider,
} from "@sentry/junior-plugin-api";

// Reviewers read the description before the diff. Each check comes from
// reviewer pushback on agent-written descriptions in getsentry/junior. A
// classifier with no reasoning answers one plain fact well, so each question
// asks one thing. A "yes" rejects the body, and the fix tells the agent what
// to send instead.
const DESCRIPTION_CHECKS = [
  {
    question:
      "Does the description report test, lint, typecheck, or CI results, include a test plan, or list commands that were run?",
    fix: "Remove check results, test plans, and commands. Reviewers see checks on the pull request.",
  },
  {
    question:
      "Does the description tell how the work was done, such as investigation steps, evidence or run counts, or approaches and names that were tried and replaced?",
    fix: "Remove the work log. Describe the change as it is now.",
  },
  {
    question:
      "Does the description list the changed files or functions one by one instead of saying what changed?",
    fix: "Replace the file list with what changed and why, in plain words.",
  },
  {
    question:
      "Does the description talk about the chat that led to the change, such as who asked, Slack messages or threads, or what the user said?",
    fix: "Remove the conversation. The runtime adds who asked.",
  },
  {
    question:
      "Does the description leave out why the change is needed or what problem it fixes?",
    fix: "Say why the change is needed.",
  },
] as const;

/** List the fixes that a pull request description needs. Empty means it passes. */
export async function pullRequestDescriptionFixes(
  decider: PluginDecider,
  body: string,
): Promise<string[]> {
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
