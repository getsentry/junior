/**
 * Best-effort detection of GitHub issue reads typed into the bash tool.
 *
 * Junior reads an issue when it starts work on it, so the read is the point
 * to remind it to claim the issue. Like `clone-command.ts`, this reads command
 * text only and misses reads behind scripts, aliases, or variables.
 */
import { parseShellCommands } from "@sentry/junior-plugin-api";

const CLAIM_NUDGE_MESSAGE =
  "If you start work on this issue, claim it first with github_updateIssue and assign_requester: true. Skip this if you only read it or already claimed it.";

const ISSUE_PATH_RE = /^\/?repos\/[^/]+\/[^/]+\/issues\/\d+$/;

/**
 * Return a claim reminder when a bash command reads one GitHub issue. Return
 * undefined for other commands.
 */
export function githubIssueReadNudge(command: string): string | undefined {
  return parseShellCommands(command).some(isIssueRead)
    ? CLAIM_NUDGE_MESSAGE
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
    args.some((arg) => ISSUE_PATH_RE.test(arg.split("?")[0]!))
  );
}
