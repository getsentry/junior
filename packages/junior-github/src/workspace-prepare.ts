import type {
  WorkspaceFinalize,
  WorkspacePrepareHookContext,
} from "@sentry/junior-plugin-api";
import { isReservedSandboxDirectory } from "./sandbox-paths.js";

/** Clone missing GitHub repositories or refresh existing Workspace checkouts. */
export async function prepareWorkspace(
  ctx: WorkspacePrepareHookContext,
): Promise<WorkspaceFinalize> {
  const repos = ctx.repos.map((entry) => {
    const [owner, name, ...rest] = entry.repo.split("/");
    if (!owner || !name || rest.length > 0) {
      throw new Error(`Invalid GitHub repository: ${entry.repo}`);
    }
    const segments = entry.path.split("/");
    if (
      segments.length === 0 ||
      segments.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          !/^[A-Za-z0-9._-]+$/.test(part),
      ) ||
      isReservedSandboxDirectory(segments[0]!)
    ) {
      throw new Error(`Invalid workspace checkout path: ${entry.path}`);
    }
    return { owner, name, path: entry.path, repo: entry.repo };
  });

  const paths = new Set<string>();
  for (const entry of repos) {
    const key = entry.path.toLowerCase();
    if (paths.has(key)) {
      throw new Error(`Workspace checkout path collision: ${entry.path}`);
    }
    paths.add(key);
  }

  const finalize: Checkout[] = [];
  for (const entry of repos) {
    // oxlint-disable-next-line no-await-in-loop -- Checkout paths can nest, so prepare them in order.
    finalize.push(await prepareCheckout(ctx, entry));
  }

  return async () => {
    for (const checkout of finalize) {
      // oxlint-disable-next-line no-await-in-loop -- Checkout paths can nest, so refresh them in order.
      await refreshCheckout(ctx, checkout);
    }
  };
}

type Checkout = { path: string; repo: string; target: string };

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Clone one repository, or find the target that refreshes its checkout. */
async function prepareCheckout(
  ctx: WorkspacePrepareHookContext,
  {
    owner,
    name,
    path,
    repo,
  }: { owner: string; name: string; path: string; repo: string },
): Promise<Checkout> {
  const parent = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : undefined;
  if (parent) {
    const mkdir = await ctx.sandbox.run({
      cmd: "mkdir",
      args: ["-p", "--", parent],
      cwd: ctx.sandbox.root,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(
        `GitHub workspace checkout parent failed for ${repo}: ${mkdir.stderr.trim() || `exit ${mkdir.exitCode}`}`,
      );
    }
  }

  const cloneUrl = `https://github.com/${owner}/${name}.git`;
  const worktree = await ctx.sandbox.run({
    cmd: "git",
    args: ["-C", path, "rev-parse", "--is-inside-work-tree"],
    cwd: ctx.sandbox.root,
    env: GIT_ENV,
  });
  const branch =
    worktree.exitCode === 0
      ? await ctx.sandbox.run({
          cmd: "git",
          args: ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"],
          cwd: ctx.sandbox.root,
          env: GIT_ENV,
        })
      : undefined;
  const branchName = branch?.stdout.trim();
  const detachedHead =
    worktree.exitCode === 0 && !branchName
      ? await ctx.sandbox.run({
          cmd: "git",
          args: ["-C", path, "rev-parse", "--verify", "HEAD^{commit}"],
          cwd: ctx.sandbox.root,
          env: GIT_ENV,
        })
      : undefined;
  const detachedSha = detachedHead?.stdout.trim();
  const validDetachedHead = Boolean(
    detachedHead?.exitCode === 0 &&
    detachedSha &&
    /^[0-9a-f]{40,64}$/.test(detachedSha),
  );
  const upstream =
    branch?.exitCode === 0 && branchName
      ? await ctx.sandbox.run({
          cmd: "git",
          args: [
            "-C",
            path,
            "rev-parse",
            "--symbolic-full-name",
            "@{upstream}",
          ],
          cwd: ctx.sandbox.root,
          env: GIT_ENV,
        })
      : undefined;
  const upstreamRef = upstream?.stdout.trim();
  const upstreamPrefix = "refs/remotes/origin/";
  const upstreamBranch = upstreamRef?.startsWith(upstreamPrefix)
    ? upstreamRef.slice(upstreamPrefix.length)
    : undefined;
  if (worktree.exitCode === 0 && (branchName || validDetachedHead)) {
    const target = upstreamBranch
      ? `${upstreamPrefix}${upstreamBranch}`
      : "HEAD";
    if (upstreamBranch) {
      const result = await ctx.sandbox.run({
        cmd: "git",
        args: [
          "-c",
          "credential.helper=",
          "-C",
          path,
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          cloneUrl,
          `+refs/heads/${upstreamBranch}:${target}`,
        ],
        cwd: ctx.sandbox.root,
        env: GIT_ENV,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `GitHub workspace refresh failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
      }
    }
    return { path, repo, target };
  }

  // A stopped execution slice can leave a complete or partial checkout. The
  // next preparation owns this fixed path and must start the clone from clean
  // state.
  const cleanup = await ctx.sandbox.run({
    cmd: "rm",
    args: ["-rf", "--", path],
    cwd: ctx.sandbox.root,
  });
  if (cleanup.exitCode !== 0) {
    throw new Error(
      `GitHub workspace checkout cleanup failed for ${repo}: ${cleanup.stderr.trim() || `exit ${cleanup.exitCode}`}`,
    );
  }
  // Full clone: Workspace checkouts need normal git history for blame,
  // merge-base, branch switches, and later refreshes.
  const result = await ctx.sandbox.run({
    cmd: "git",
    args: ["clone", "--quiet", "--", cloneUrl, path],
    cwd: ctx.sandbox.root,
    env: GIT_ENV,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `GitHub workspace clone failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return { path, repo, target: "HEAD" };
}

/** Reset one checkout to its target and remove untracked files. */
async function refreshCheckout(
  ctx: WorkspacePrepareHookContext,
  { path, repo, target }: Checkout,
): Promise<void> {
  for (const args of [
    ["-C", path, "reset", "--hard", target],
    ["-C", path, "clean", "-fd"],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Clean only after the reset.
    const result = await ctx.sandbox.run({
      cmd: "git",
      args,
      cwd: ctx.sandbox.root,
      env: GIT_ENV,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub workspace refresh failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }
}
