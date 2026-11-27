/**
 * What a shell command can reach, for Guardian (`sandbox-boundary`). The
 * remotes come from the Sandbox, and the clone records type each one. Before
 * a push that can reach `world`, the commits that no remote has show what
 * the push publishes, since edits and commits stay in the Sandbox until then.
 */
import type { PluginManifest } from "@sentry/junior-plugin-api";
import { posix } from "node:path";
import * as z from "zod";
import { mapBounded } from "@/chat/fan-out";
import { targetOfUrl } from "@/chat/guardian/checkout-records";
import type { ReviewRequest, Target } from "@/chat/guardian/guardian";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

type SandboxFacts = NonNullable<ReviewRequest["sandbox"]>;

/** One Git checkout in the Sandbox and every fetch and push URL it has. */
export interface SandboxRepo {
  path: string;
  remotes: string[];
}

// Print the top-level path and each remote fetch or push URL of each Git
// checkout one or two levels under the root, such as a Workspace's
// `repos/<name>`, and of each directory given after the root, one per line.
const LIST_REPOS_SCRIPT = [
  "list() {",
  '  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 0',
  '  git -C "$top" remote -v | while read -r _ url _; do',
  '    printf \'%s\\t%s\\n\' "$top" "$url"',
  "  done",
  "}",
  "root=$1; shift",
  'for dir in "$root"/*/ "$root"/repos/*/; do',
  '  if [ -e "$dir/.git" ]; then list "$dir"; fi',
  "done",
  'for dir in "$@"; do',
  '  if [ -d "$dir" ]; then list "$dir"; fi',
  "done",
].join("\n");

/**
 * Read the Git checkouts of a running Sandbox, with their remote URLs: those
 * under the root, and those that hold the directories that commands run in.
 * A relative directory is under the root, as bash runs there by default.
 */
export async function readSandboxRepos(
  workspace: Pick<SandboxWorkspace, "runCommand">,
  root: string,
  dirs: readonly string[] = [],
): Promise<SandboxRepo[]> {
  const result = await workspace.runCommand({
    cmd: "bash",
    args: [
      "-c",
      LIST_REPOS_SCRIPT,
      "list-repos",
      root,
      ...dirs.map((dir) => posix.resolve(root, dir)),
    ],
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

const shellInputSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
});

// A repository URL: `scheme://...` or scp-like `user@host:path`.
const REPO_URL = /(?:https?|ssh|git):\/\/[^\s'"]+|[\w.-]+@[\w.-]+:[^\s'"]+/g;

/**
 * The directory that a path argument names from `cwd`, or undefined when the
 * shell expands it, such as `~` or `$DIR`, or when `cwd` is unknown.
 */
function dirFrom(cwd: string | undefined, arg: string): string | undefined {
  const path = arg.replace(/^(['"])(.*)\1$/, "$2");
  if (!path || /^[-~]|\$/.test(path)) return undefined;
  if (path.startsWith("/")) return path;
  return cwd === undefined ? undefined : posix.join(cwd, path);
}

/**
 * What one shell call does with Git: whether it pushes, in any form such as
 * `git -C <path> push <remote> <refspec>`, the repository URLs that its `git`
 * invocations name, such as a push or `remote add` target, and the
 * directories they run in: the `-C` path, or the working directory after
 * any `cd` before it. A relative directory is relative to the root.
 */
export function gitCommandFacts(input: unknown): {
  pushes: boolean;
  urls: string[];
  dirs: string[];
} {
  const facts: { pushes: boolean; urls: string[]; dirs: string[] } = {
    pushes: false,
    urls: [],
    dirs: [],
  };
  const parsed = shellInputSchema.safeParse(input);
  if (!parsed.success) return facts;
  // Undefined after a `cd` to a path that the shell expands.
  let cwd: string | undefined = parsed.data.cwd ?? ".";
  for (const segment of parsed.data.command.split(/&&|\|\||[;|\n]/)) {
    const cd = /^\s*cd\s+(\S+)/.exec(segment);
    if (cd) {
      cwd = dirFrom(cwd, cd[1]!);
      continue;
    }
    const git = /\bgit\b.*/.exec(segment)?.[0];
    if (!git) continue;
    facts.pushes ||= /\bpush\b/.test(git);
    facts.urls.push(...(git.match(REPO_URL) ?? []));
    const option = /\s-C\s+(\S+)/.exec(git)?.[1];
    const dir = option === undefined ? cwd : dirFrom(cwd, option);
    if (dir && !facts.dirs.includes(dir)) facts.dirs.push(dir);
  }
  return facts;
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
  /** The recorded target of each clone URL (`readCheckoutTargets`). */
  targets: ReadonlyMap<string, Target>;
}): Promise<SandboxFacts> {
  const describe = (url: string) => targetOfUrl(url, args.targets);
  const urls = [...new Set(args.urls)].map(describe);
  const toWorldUrl = urls.some((target) => target.audience === "world");
  const repos = await mapBounded(args.repos, async (repo) => {
    const remotes = repo.remotes.map(describe);
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
