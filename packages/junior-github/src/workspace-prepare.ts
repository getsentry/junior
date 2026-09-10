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

  const gitEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };

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
      env: gitEnv,
    });
    const branch =
      worktree.exitCode === 0
        ? await ctx.sandbox.run({
            cmd: "git",
            args: ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"],
            cwd: ctx.sandbox.root,
            env: gitEnv,
          })
        : undefined;
    const branchName = branch?.stdout.trim();
    const detachedHead =
      worktree.exitCode === 0 && !branchName
        ? await ctx.sandbox.run({
            cmd: "git",
            args: ["-C", path, "rev-parse", "--verify", "HEAD^{commit}"],
            cwd: ctx.sandbox.root,
            env: gitEnv,
          })
        : undefined;
    const detachedSha = detachedHead?.stdout.trim();
    const validDetachedSha =
      detachedHead?.exitCode === 0 &&
      detachedSha &&
      /^[0-9a-f]{40,64}$/.test(detachedSha)
        ? detachedSha
        : undefined;
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
            env: gitEnv,
          })
        : undefined;
    const upstreamRef = upstream?.stdout.trim();
    const upstreamPrefix = "refs/remotes/origin/";
    const upstreamBranch = upstreamRef?.startsWith(upstreamPrefix)
      ? upstreamRef.slice(upstreamPrefix.length)
      : undefined;
    if (worktree.exitCode === 0 && (branchName || validDetachedSha)) {
      const localBranch = branchName || "workspace-detached";
      const remoteBranch = upstreamBranch || branchName;
      const remoteRef = remoteBranch
        ? `${upstreamPrefix}${remoteBranch}`
        : validDetachedSha!;
      // Build trusted Git metadata outside the checkout before replacing the
      // snapshot metadata. Reuse the cached object database, but do not reuse
      // snapshot hooks, filters, or remote config during credentialed Git commands.
      const tempDir = await ctx.sandbox.run({
        cmd: "mktemp",
        args: ["-d", `${ctx.sandbox.juniorRoot}/workspace-refresh.XXXXXX`],
        cwd: ctx.sandbox.root,
      });
      const refreshGitDir = tempDir.stdout.trim();
      if (tempDir.exitCode !== 0 || !refreshGitDir) {
        throw new Error(
          `GitHub workspace refresh temp directory failed for ${repo}: ${tempDir.stderr.trim() || `exit ${tempDir.exitCode}`}`,
        );
      }
      const gitArgs = (...args: string[]) => [
        "--git-dir",
        refreshGitDir,
        "--work-tree",
        path,
        ...args,
      ];
      const refreshCommands: Array<{
        args: string[];
        cmd: string;
        credentialed?: boolean;
      }> = [
        {
          cmd: "git",
          args: gitArgs("init", "--quiet", "--initial-branch", localBranch),
          credentialed: true,
        },
        {
          cmd: "git",
          args: gitArgs("remote", "add", "origin", cloneUrl),
          credentialed: true,
        },
        { cmd: "rm", args: ["-rf", "--", `${refreshGitDir}/objects`] },
        {
          cmd: "cp",
          args: [
            "-al",
            "--",
            `${path}/.git/objects`,
            `${refreshGitDir}/objects`,
          ],
        },
        ...(remoteBranch
          ? [
              {
                cmd: "git",
                args: gitArgs(
                  "fetch",
                  "--quiet",
                  "--prune",
                  "--no-tags",
                  "origin",
                  `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`,
                ),
                credentialed: true,
              },
            ]
          : []),
        ...(validDetachedSha
          ? [
              {
                cmd: "git",
                args: gitArgs(
                  "update-ref",
                  "--no-deref",
                  "HEAD",
                  validDetachedSha,
                ),
                credentialed: true,
              },
            ]
          : []),
        {
          cmd: "git",
          args: gitArgs("reset", "--hard", remoteRef),
          credentialed: true,
        },
        ...(remoteBranch && branchName
          ? [
              {
                cmd: "git",
                args: gitArgs(
                  "branch",
                  `--set-upstream-to=origin/${remoteBranch}`,
                  branchName,
                ),
                credentialed: true,
              },
            ]
          : []),
      ];
      for (const command of refreshCommands) {
        const result = await ctx.sandbox.run({
          cmd: command.cmd,
          args: command.args,
          cwd: ctx.sandbox.root,
          ...(command.credentialed ? { env: gitEnv } : undefined),
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `GitHub workspace refresh failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
          );
        }
      }
      for (const [cmd, args] of [
        ["rm", ["-rf", "--", `${path}/.git`]],
        ["mv", ["--", refreshGitDir, `${path}/.git`]],
      ] as const) {
        const result = await ctx.sandbox.run({
          cmd,
          args: [...args],
          cwd: ctx.sandbox.root,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `GitHub workspace metadata replacement failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
          );
        }
      }
      const clean = await ctx.sandbox.run({
        cmd: "git",
        args: ["-C", path, "clean", "-fd"],
        cwd: ctx.sandbox.root,
        env: gitEnv,
      });
      if (clean.exitCode !== 0) {
        throw new Error(
          `GitHub workspace refresh failed for ${repo}: ${clean.stderr.trim() || `exit ${clean.exitCode}`}`,
        );
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
      env: gitEnv,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub workspace clone failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }
}
