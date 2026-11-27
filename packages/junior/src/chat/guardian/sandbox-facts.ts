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

/** One Git checkout in the Sandbox and every fetch and push URL it has. */
export interface SandboxRepo {
  path: string;
  remotes: string[];
}

// Print the path and each remote fetch or push URL of each Git checkout one
// or two levels under the root, such as a Workspace's `repos/<name>`.
const LIST_REPOS_SCRIPT = [
  'for dir in "$1"/*/ "$1"/repos/*/; do',
  '  [ -e "$dir/.git" ] || continue',
  '  git -C "$dir" remote -v 2>/dev/null | while read -r _ url _; do',
  '    printf \'%s\\t%s\\n\' "${dir%/}" "$url"',
  "  done",
  "done",
].join("\n");

/** Read the Git checkouts of a running Sandbox, with their remote URLs. */
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
  const remotes = new Map<string, Set<string>>();
  for (const line of result.stdout.split("\n")) {
    const [path, url] = line.split("\t");
    if (path && url)
      remotes.set(path, (remotes.get(path) ?? new Set()).add(url));
  }
  return [...remotes].map(([path, urls]) => ({ path, remotes: [...urls] }));
}

/** Most characters of unpushed commits that one checkout's facts keep. */
const MAX_UNPUSHED_CHARS = 12_000;

const shellInputSchema = z.object({ command: z.string() });

// One `git` invocation: up to the next command separator.
const GIT_SEGMENT = /\bgit\b[^\n;&|]*/g;
// A repository URL: `scheme://...` or scp-like `user@host:path`.
const REPO_URL = /(?:https?|ssh|git):\/\/[^\s'"]+|[\w.-]+@[\w.-]+:[^\s'"]+/g;

/**
 * What one shell call does with Git: whether it pushes, in any form such as
 * `git -C <path> push <remote> <refspec>`, and the repository URLs that its
 * `git` invocations name, such as a push or `remote add` target.
 */
export function gitCommandFacts(input: unknown): {
  pushes: boolean;
  urls: string[];
} {
  const parsed = shellInputSchema.safeParse(input);
  const segments = parsed.success
    ? (parsed.data.command.match(GIT_SEGMENT) ?? [])
    : [];
  return {
    pushes: segments.some((segment) => /\bpush\b/.test(segment)),
    urls: segments.flatMap((segment) => segment.match(REPO_URL) ?? []),
  };
}

/**
 * Read the commits on any local branch of one checkout that no remote
 * branch has yet, with their patches, cut to a bound. This covers a push of
 * any branch, also its first push. A stale remote ref can only add commits
 * here, never hide one.
 */
export async function readUnpushedCommits(
  workspace: Pick<SandboxWorkspace, "runCommand">,
  path: string,
): Promise<string> {
  const result = await workspace.runCommand({
    cmd: "git",
    args: [
      "-C",
      path,
      "log",
      "-p",
      "--no-color",
      "--branches",
      "--not",
      "--remotes",
    ],
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
 * What the Sandbox can reach: its typed Git checkouts, the repository URLs
 * that the commands name, and placeholders. When the batch pushes and can
 * reach a `world` target, the checkouts that may publish also get their
 * unpushed commits. A push to a URL can come from any checkout.
 */
export async function sandboxFacts(args: {
  repos: readonly SandboxRepo[];
  /** Repository URLs that the batch's shell commands name. */
  urls: readonly string[];
  placeholders: SandboxFacts["placeholders"];
  /** Set only when the batch has a `git push`. */
  unpushed?: (path: string) => Promise<string>;
  /** What each plugin's `describeUrl` may read. */
  readContext: (plugin: string) => DescribeReadContext;
}): Promise<SandboxFacts> {
  const describe = (url: string) => describeRemote(url, args.readContext);
  const urls = await mapBounded([...new Set(args.urls)], describe);
  const toWorldUrl = urls.some((target) => target.audience === "world");
  const repos = await mapBounded(args.repos, async (repo) => {
    const remotes = await mapBounded(repo.remotes, describe);
    const publishes =
      toWorldUrl || remotes.some((target) => target.audience === "world");
    const unpushed =
      args.unpushed && publishes ? await args.unpushed(repo.path) : "";
    return {
      path: repo.path,
      remotes,
      ...(unpushed ? { unpushed } : undefined),
    };
  });
  return {
    repos,
    ...(urls.length > 0 ? { urls } : undefined),
    placeholders: args.placeholders,
  };
}
