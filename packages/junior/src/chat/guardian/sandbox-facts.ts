/**
 * What a shell command can reach, for Guardian (`sandbox-boundary`). The
 * remotes come from the Sandbox, and `describeUrl` types each one. Before a
 * push to a `world` checkout, the commits that no remote has show what the
 * push publishes, since edits and commits stay in the Sandbox until then.
 */
import type {
  DescribeReadContext,
  PluginManifest,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { mapBounded } from "@/chat/fan-out";
import type { ReviewRequest } from "@/chat/guardian/guardian";
import { describeRemote } from "@/chat/plugins/describe-url";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

type SandboxFacts = NonNullable<ReviewRequest["sandbox"]>;

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
  // A failed or timed-out listing is not a Sandbox without checkouts.
  if (result.exitCode !== 0) {
    throw new Error(
      `Listing the Sandbox checkouts failed with exit ${result.exitCode}.`,
    );
  }
  return result.stdout.split("\n").flatMap((line) => {
    const [path, remote] = line.split("\t");
    return path && remote ? [{ path, remote }] : [];
  });
}

/** Most characters of unpushed commits that one checkout's facts keep. */
const MAX_UNPUSHED_CHARS = 12_000;

const shellInputSchema = z.object({ command: z.string() });

/** Whether the input of a shell call runs `git push`. */
export function isGitPush(input: unknown): boolean {
  const parsed = shellInputSchema.safeParse(input);
  return parsed.success && /\bgit\b[^\n;&|]*\bpush\b/.test(parsed.data.command);
}

/**
 * Read the commits of one checkout that no remote branch has yet, with
 * their patches, cut to a bound. This covers the first push of a new
 * branch. A stale remote ref can only add commits here, never hide one.
 */
export async function readUnpushedCommits(
  workspace: Pick<SandboxWorkspace, "runCommand">,
  path: string,
): Promise<string> {
  const result = await workspace.runCommand({
    cmd: "git",
    args: ["-C", path, "log", "-p", "--no-color", "HEAD", "--not", "--remotes"],
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Reading the unpushed commits of ${path} failed with exit ${result.exitCode}.`,
    );
  }
  const log = result.stdout;
  return log.length <= MAX_UNPUSHED_CHARS
    ? log
    : `${log.slice(0, MAX_UNPUSHED_CHARS)}\n[truncated]`;
}

/** Credential placeholders that the installed plugins put in the Sandbox. */
export function credentialPlaceholders(
  manifests: readonly PluginManifest[],
): SandboxFacts["placeholders"] {
  return manifests.flatMap((manifest) => {
    const credentials = manifest.credentials;
    return credentials?.type === "oauth-bearer" && credentials.authTokenEnv
      ? [{ env: credentials.authTokenEnv, domains: [...credentials.domains] }]
      : [];
  });
}

/**
 * What the Sandbox can reach: its typed Git checkouts and placeholders. When
 * the batch pushes, each `world` checkout also gets its unpushed commits.
 */
export async function sandboxFacts(args: {
  repos: readonly SandboxRepo[];
  placeholders: SandboxFacts["placeholders"];
  /** Set only when the batch has a `git push`. */
  unpushed?: (path: string) => Promise<string>;
  /** What each plugin's `describeUrl` may read. */
  readContext: (plugin: string) => DescribeReadContext;
}): Promise<SandboxFacts> {
  return {
    repos: await mapBounded(args.repos, async (repo) => {
      const target = await describeRemote(repo.remote, args.readContext);
      const unpushed =
        args.unpushed && target.audience === "world"
          ? await args.unpushed(repo.path)
          : "";
      return {
        path: repo.path,
        target,
        ...(unpushed ? { unpushed } : undefined),
      };
    }),
    placeholders: args.placeholders,
  };
}
