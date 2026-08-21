import type { WorkspacePrepareHookContext } from "@sentry/junior-plugin-api";
import { isReservedSandboxDirectory } from "./sandbox-paths.js";

/** Clone missing GitHub repositories or refresh existing Workspace checkouts. */
export async function prepareWorkspace(
  ctx: WorkspacePrepareHookContext,
): Promise<void> {
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

  for (const { owner, name, path, repo } of repos) {
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
    });
    const branch =
      worktree.exitCode === 0
        ? await ctx.sandbox.run({
            cmd: "git",
            args: ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"],
            cwd: ctx.sandbox.root,
          })
        : undefined;
    const branchName = branch?.stdout.trim();
    if (branch?.exitCode === 0 && branchName) {
      // Existing Workspace checkouts keep setup outputs under ignored paths.
      // Pin origin before network access, then reset the tracked tree without
      // wiping those installs. The explicit refspec ignores snapshot config.
      for (const args of [
        ["-C", path, "config", "--replace-all", "remote.origin.url", cloneUrl],
        [
          "-C",
          path,
          "fetch",
          "--quiet",
          "origin",
          `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
        ],
        ["-C", path, "reset", "--hard", `refs/remotes/origin/${branchName}`],
        ["-C", path, "clean", "-fd"],
      ]) {
        const result = await ctx.sandbox.run({
          cmd: "git",
          args,
          cwd: ctx.sandbox.root,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `GitHub workspace refresh failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
          );
        }
      }
      continue;
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
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub workspace clone failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }
}
