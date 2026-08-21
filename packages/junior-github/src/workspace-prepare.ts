import type { WorkspacePrepareHookContext } from "@sentry/junior-plugin-api";
import { isReservedSandboxDirectory } from "./sandbox-paths.js";

/** Clone or reset GitHub repositories in their host-selected Workspace paths. */
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
    const checkout = await ctx.sandbox.run({
      cmd: "git",
      args: ["-C", path, "rev-parse", "--is-inside-work-tree"],
      cwd: ctx.sandbox.root,
    });
    if (checkout.exitCode === 0) {
      // Fresh Workspace boots keep setup outputs under ignored paths. Reset the
      // tracked tree to the current upstream without wiping those installs.
      const commands = [
        ["-C", path, "fetch", "--quiet", "origin"],
        ["-C", path, "reset", "--hard", "@{upstream}"],
        ["-C", path, "clean", "-fd"],
      ];
      for (const args of commands) {
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
    // next slice owns this fixed path and must start the clone from clean state.
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
    const result = await ctx.sandbox.run({
      cmd: "git",
      args: [
        "clone",
        "--quiet",
        "--depth=1",
        "--",
        `https://github.com/${owner}/${name}.git`,
        path,
      ],
      cwd: ctx.sandbox.root,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub workspace clone failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }
}
