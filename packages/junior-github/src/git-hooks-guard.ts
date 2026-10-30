/**
 * Keep agent tool calls from turning off Junior's Git hooks.
 *
 * Junior's hooks must run on every Git command, and the agent must not
 * replace them. The plugin points Git at Junior's hooks with command env
 * config, which wins over every config file. Git still lets a command win
 * over that env config, and the hook files are writable in the sandbox. This
 * guard denies the direct ways to do that:
 *
 * - `git -c core.hooksPath=...` and `git --config-env core.hooksPath=...`
 * - setting, exporting, or unsetting the `GIT_CONFIG_*` env entries
 * - changing files in Junior's hooks directory
 *
 * It reads tool input text only. A script file, an alias, or `sudo` can still
 * get around it. `--no-verify` is not denied: it skips repository checks, but
 * Git still runs Junior's `prepare-commit-msg` hook.
 */
import { posix } from "node:path";
import { gitHooksPath } from "./git-config.js";

const HOOKS_PATH_OPTION_RE =
  /(?:^|[\s;&|(`'"])(?:-c|--config-env)(?:\s+|=)['"]?core\.hookspath=/im;

const GIT_CONFIG_ENV_NAME = String.raw`GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)\b`;

/** Sets or unsets a Git config env entry. Reads, such as grep, stay allowed. */
const GIT_CONFIG_ENV_RE = new RegExp(
  String.raw`(?<![\w$])${GIT_CONFIG_ENV_NAME}=|(?:\bunset|\s-u|\s--unset)(?:\s+|=)(?:\S+\s+)*?${GIT_CONFIG_ENV_NAME}`,
);

const HOOKS_OVERRIDE_DENIAL =
  "Junior's Git hooks must run on every Git command. Do not set core.hooksPath, change GIT_CONFIG_* environment variables, or edit Junior's hooks directory. Run Git commands without these overrides.";

const FILE_TOOLS = new Set(["editFile", "writeFile"]);

/**
 * Return a deny reason when a tool call would change or skip Junior's Git
 * hooks. Return undefined for other calls.
 */
export function gitHooksOverrideDenial(args: {
  input: Record<string, unknown>;
  juniorRoot: string;
  toolName: string;
}): string | undefined {
  // Match absolute paths and paths relative to the sandbox root.
  const hooksDir = gitHooksPath(posix.basename(args.juniorRoot));
  if (args.toolName === "bash") {
    const command = args.input.command;
    if (
      typeof command === "string" &&
      (HOOKS_PATH_OPTION_RE.test(command) ||
        GIT_CONFIG_ENV_RE.test(command) ||
        command.includes(hooksDir))
    ) {
      return HOOKS_OVERRIDE_DENIAL;
    }
    return undefined;
  }
  if (
    FILE_TOOLS.has(args.toolName) &&
    typeof args.input.path === "string" &&
    args.input.path.includes(hooksDir)
  ) {
    return HOOKS_OVERRIDE_DENIAL;
  }
  return undefined;
}
