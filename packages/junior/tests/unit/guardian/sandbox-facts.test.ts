import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitCommandFacts,
  readSandboxRepos,
  readUnpushedCommits,
} from "@/chat/guardian/sandbox-facts";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

/** Runs Sandbox commands on this machine, as the Sandbox runs them. */
const localWorkspace: Pick<SandboxWorkspace, "runCommand"> = {
  async runCommand({ cmd, args = [] }) {
    const result = spawnSync(cmd, args, { encoding: "utf8" });
    return {
      exitCode: result.status ?? 1,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  },
};

// Commit as the machine's Git identity, or as a test identity when it has
// none, such as on CI.
const identity = spawnSync("git", ["config", "user.email"], {
  encoding: "utf8",
}).stdout.trim()
  ? []
  : ["-c", "user.name=test", "-c", "user.email=test@example.com"];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", [...identity, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

/** A Sandbox root with one checkout whose `main` is pushed to a remote. */
function sandboxRoot(): { root: string; checkout: string } {
  const root = mkdtempSync(path.join(tmpdir(), "sandbox-facts-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", remote);
  const checkout = path.join(root, "repos", "demo");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "remote", "add", "origin", remote);
  writeFileSync(path.join(checkout, "a.txt"), "a\n");
  git(checkout, "add", "a.txt");
  git(checkout, "commit", "-q", "-m", "pushed");
  git(checkout, "push", "-q", "origin", "main");
  return { root, checkout };
}

describe("sandbox facts", () => {
  it("lists every fetch and push URL of each checkout", async () => {
    const { root, checkout } = sandboxRoot();
    git(
      checkout,
      "remote",
      "add",
      "upstream",
      "https://github.com/acme/up.git",
    );
    git(
      checkout,
      "remote",
      "set-url",
      "--push",
      "upstream",
      "https://github.com/acme/mirror.git",
    );
    mkdirSync(path.join(root, "scratch"));

    await expect(readSandboxRepos(localWorkspace, root)).resolves.toEqual([
      {
        path: checkout,
        remotes: [
          path.join(root, "remote.git"),
          "https://github.com/acme/up.git",
          "https://github.com/acme/mirror.git",
        ],
      },
    ]);
  });

  it("reads unpushed commits on every local branch and a detached HEAD", async () => {
    const { checkout } = sandboxRoot();
    git(checkout, "checkout", "-q", "-b", "fix/export");
    writeFileSync(path.join(checkout, "b.txt"), "Acme Corp, $1.2M ARR\n");
    git(checkout, "add", "b.txt");
    git(checkout, "commit", "-q", "-m", "unpushed");
    git(checkout, "checkout", "-q", "--detach", "main");
    writeFileSync(path.join(checkout, "c.txt"), "Globex, $3M ARR\n");
    git(checkout, "add", "c.txt");
    git(checkout, "commit", "-q", "-m", "detached");

    const log = await readUnpushedCommits(localWorkspace, checkout);

    expect(log).toContain("Acme Corp, $1.2M ARR");
    expect(log).toContain("Globex, $3M ARR");
    // The commit that `origin` has is not in the log.
    expect(log).not.toMatch(/^ {4}pushed$/m);
  });

  it("lists the checkout that a command runs in outside the root", async () => {
    const { root } = sandboxRoot();
    const clone = mkdtempSync(path.join(tmpdir(), "sandbox-clone-"));
    roots.push(clone);
    git(clone, "init", "-q");
    git(clone, "remote", "add", "origin", "https://github.com/acme/demo.git");
    mkdirSync(path.join(clone, "src"));

    const repos = await readSandboxRepos(localWorkspace, root, [
      path.join(clone, "src"),
    ]);

    expect(repos).toContainEqual({
      path: clone,
      remotes: ["https://github.com/acme/demo.git"],
    });
  });

  it.each([
    ["git push upstream", [], ["."]],
    ["cd repos/demo && git push origin fix/export:main", [], ["repos/demo"]],
    ["cd /tmp/demo && git push", [], ["/tmp/demo"]],
    ["git -C /tmp/demo push --force-with-lease", [], ["/tmp/demo"]],
    ["cd /tmp && git -C demo push", [], ["/tmp/demo"]],
    ["cd $HOME/demo && git push", [], []],
    [
      "git push https://github.com/getsentry/junior.git HEAD",
      ["https://github.com/getsentry/junior.git"],
      ["."],
    ],
    [
      "git remote add pub git@github.com:getsentry/junior.git; git push pub",
      ["git@github.com:getsentry/junior.git"],
      ["."],
    ],
  ])("finds the push in `%s`", (command, urls, dirs) => {
    expect(gitCommandFacts({ command })).toEqual({ pushes: true, urls, dirs });
  });

  it("does not take a URL from a command that is not git", () => {
    expect(
      gitCommandFacts({ command: "curl https://example.com/x && git status" }),
    ).toEqual({ pushes: false, urls: [], dirs: ["."] });
  });
});
