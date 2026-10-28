/**
 * Best-effort detection of GitHub clones typed into the bash tool.
 *
 * `github_cloneRepository` checks for a matching Workspace before it clones.
 * A raw `git clone` or `gh repo clone` skips that check. This check is
 * brittle: `parseShellCommands` reads command text only, so it misses clones
 * behind `sh -c`, `eval`, scripts, aliases, or variables. It is steering for
 * the model, not a security boundary. Egress cannot block clones either,
 * because clone and fetch use the same `git-upload-pack` request.
 */
import { parseShellCommands } from "@sentry/junior-plugin-api";

const CLONE_DENIAL_MESSAGE =
  "Use github_cloneRepository to clone GitHub repositories, not git clone or gh repo clone. It checks for a matching Workspace first.";

/** Git global options that take the next token as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c"]);

/**
 * Return a denial message when a bash command clones a GitHub repository
 * without `github_cloneRepository`. Return undefined for other commands.
 */
export function githubCloneCommandDenial(command: string): string | undefined {
  return parseShellCommands(command).some(isGitHubClone)
    ? CLONE_DENIAL_MESSAGE
    : undefined;
}

function isGitHubClone([program, ...args]: string[]): boolean {
  if (program === "gh") {
    return (
      args[0] === "repo" &&
      (args[1] === "clone" ||
        (args[1] === "fork" &&
          args.some((arg) => arg === "--clone" || arg === "--clone=true")))
    );
  }
  if (program !== "git") {
    return false;
  }
  let index = 0;
  while (args[index]?.startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(args[index]!) ? 2 : 1;
  }
  // Only GitHub remotes. Local and other-host clones stay allowed.
  return args[index] === "clone" && args.slice(index + 1).some(isGitHubRemote);
}

/** Match `git@github.com:owner/repo` and URLs whose host is `github.com`. */
function isGitHubRemote(arg: string): boolean {
  const scpHost = /^[^@/:]+@([^/:]+):/.exec(arg)?.[1];
  if (scpHost) {
    return scpHost.toLowerCase() === "github.com";
  }
  try {
    return new URL(arg).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}
