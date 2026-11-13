/**
 * Best-effort detection of bash commands that turn off Junior's Git hooks.
 *
 * Junior sets `core.hooksPath` in the command env. A `git -c` or
 * `--config-env` override has a higher priority, so it skips the
 * `prepare-commit-msg` hook that sets commit attribution. Models use it to
 * skip a slow repository `pre-commit` hook, and the commit then keeps
 * model-supplied co-authors. Like `githubCloneCommandRedirect`, this reads
 * command text only, so it is steering for the model, not a security
 * boundary.
 */
import { parseShellCommands } from "@sentry/junior-plugin-api";
import { GIT_OPTIONS_WITH_VALUE } from "./clone-command.js";

const HOOKS_PATH_REDIRECT_MESSAGE =
  "Do not override core.hooksPath. Junior's Git hooks set commit attribution. To skip the repository's pre-commit and commit-msg hooks, use `git commit --no-verify`.";

/**
 * Return a redirect message when a bash command overrides `core.hooksPath`
 * for a Git command. Return undefined for other commands.
 */
export function gitHooksPathOverrideRedirect(
  command: string,
): string | undefined {
  return parseShellCommands(command).some(overridesHooksPath)
    ? HOOKS_PATH_REDIRECT_MESSAGE
    : undefined;
}

function overridesHooksPath([program, ...args]: string[]): boolean {
  if (program !== "git") {
    return false;
  }
  for (let index = 0; args[index]?.startsWith("-"); index += 1) {
    const option = args[index]!;
    const value = option.startsWith("--config-env=")
      ? option.slice("--config-env=".length)
      : option === "-c" || option === "--config-env"
        ? args[index + 1]
        : undefined;
    // Git config section and key names are case-insensitive.
    if (value?.toLowerCase().startsWith("core.hookspath=")) {
      return true;
    }
    if (GIT_OPTIONS_WITH_VALUE.has(option)) {
      index += 1;
    }
  }
  return false;
}
