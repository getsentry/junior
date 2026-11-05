/**
 * Best-effort detection of GitHub issue reads typed into the bash tool.
 *
 * `github_getIssue` tells the agent when to claim the issue, so a raw read
 * would skip that step. Like `clone-command.ts`, this reads command text only.
 * Egress policy denies the reads that this check misses.
 */
import { parseShellCommands } from "@sentry/junior-plugin-api";

/** Tells the agent to read one issue with `github_getIssue`. */
export const ISSUE_READ_REDIRECT_MESSAGE =
  "Use github_getIssue to read a GitHub issue, not gh issue view or gh api. Read comments with gh api repos/OWNER/REPO/issues/NUMBER/comments.";

/** One issue's REST path, with or without the leading slash. */
export const ISSUE_PATH = /^\/?repos\/[^/]+\/[^/]+\/issues\/\d+$/;

/**
 * Return a redirect message when a bash command reads one GitHub issue
 * without `github_getIssue`. Return undefined for other commands.
 */
export function githubIssueReadRedirect(command: string): string | undefined {
  return parseShellCommands(command).some(isIssueRead)
    ? ISSUE_READ_REDIRECT_MESSAGE
    : undefined;
}

function isIssueRead([program, ...args]: string[]): boolean {
  if (program !== "gh") {
    return false;
  }
  if (args[0] === "issue") {
    return args[1] === "view";
  }
  if (args[0] !== "api") {
    return false;
  }
  const method = args.reduce<string | undefined>((value, arg, index) => {
    if (arg === "-X" || arg === "--method") {
      return args[index + 1];
    }
    return arg.startsWith("--method=") ? arg.slice("--method=".length) : value;
  }, undefined);
  return (
    (method === undefined || method.toUpperCase() === "GET") &&
    args.some((arg) => ISSUE_PATH.test(arg.split("?")[0]!))
  );
}
