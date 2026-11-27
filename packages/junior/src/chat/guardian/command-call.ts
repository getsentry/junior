/**
 * The call of one shell command, which Guardian reviews before it runs
 * (`sandbox-boundary` in `design/guardian.md`).
 *
 * Code only reads facts here. The Git remotes come from the Sandbox, a
 * plugin's `describeUrl` hook types each one, and the plugin manifests say
 * which credential placeholder goes to which domains.
 */
import type { PluginManifest } from "@sentry/junior-plugin-api";
import { mapBounded } from "@/chat/fan-out";
import type { Call } from "@/chat/guardian/guardian";
import { describeRemote } from "@/chat/plugins/describe-url";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

/** The call of one shell command. */
type CommandCall = Extract<Call, { effect: "command" }>;

/** Longest command text that the call summary keeps. */
const MAX_SUMMARY_CHARS = 2_000;

/** One Git checkout in the Sandbox and the URL of its `origin` remote. */
export interface SandboxRepo {
  path: string;
  remote: string;
}

// Print the path and `origin` URL of each Git checkout one or two levels
// under the root, such as a Workspace's `repos/<name>`, one per line.
const LIST_REPOS_SCRIPT = [
  'for dir in "$1"/*/ "$1"/repos/*/; do',
  '  url=$(git -C "$dir" remote get-url origin 2>/dev/null) || continue',
  '  printf \'%s\\t%s\\n\' "${dir%/}" "$url"',
  "done",
].join("\n");

/** Read the Git checkouts of a running Sandbox, with their `origin` URLs. */
export async function readSandboxRepos(
  workspace: Pick<SandboxWorkspace, "runCommand">,
  root: string,
): Promise<SandboxRepo[]> {
  const result = await workspace.runCommand({
    cmd: "bash",
    args: ["-c", LIST_REPOS_SCRIPT, "list-repos", root],
    timeoutMs: 10_000,
  });
  return result.stdout.split("\n").flatMap((line) => {
    const [path, remote] = line.split("\t");
    return path && remote ? [{ path, remote }] : [];
  });
}

/** Credential placeholders that the installed plugins put in the Sandbox. */
export function credentialPlaceholders(
  manifests: readonly PluginManifest[],
): CommandCall["placeholders"] {
  return manifests.flatMap((manifest) => {
    const credentials = manifest.credentials;
    return credentials?.type === "oauth-bearer" && credentials.authTokenEnv
      ? [{ env: credentials.authTokenEnv, domains: [...credentials.domains] }]
      : [];
  });
}

/** Build the call of one `bash` call. */
export async function commandCall(args: {
  input: Record<string, unknown>;
  repos: readonly SandboxRepo[];
  placeholders: CommandCall["placeholders"];
}): Promise<CommandCall> {
  const command =
    typeof args.input["command"] === "string" ? args.input["command"] : "";
  return {
    effect: "command",
    summary:
      command.length <= MAX_SUMMARY_CHARS
        ? command
        : `${command.slice(0, MAX_SUMMARY_CHARS)} [truncated]`,
    repos: await mapBounded(args.repos, async (repo) => ({
      path: repo.path,
      target: await describeRemote(repo.remote),
    })),
    placeholders: args.placeholders,
  };
}
