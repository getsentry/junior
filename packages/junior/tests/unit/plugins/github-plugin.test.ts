import type { SandboxPrepareHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { githubPlugin } from "../../../../junior-github/index.js";

const ORIGINAL_ENV = { ...process.env };

function beforeToolContext(requester: {
  email?: string;
  fullName?: string;
  userId?: string;
  userName?: string;
}) {
  const env: Record<string, string> = {};
  let denial: string | undefined;

  return {
    ctx: {
      decision: {
        deny(message: string) {
          denial = message;
        },
        replaceInput() {},
      },
      env: {
        get(key: string) {
          return env[key];
        },
        set(key: string, value: string) {
          env[key] = value;
        },
      },
      log: {
        error() {},
        info() {},
        warn() {},
      },
      plugin: { name: "github" },
      requester,
      tool: {
        input: { command: "git commit -m test" },
        name: "bash",
      },
    },
    env,
    get denial() {
      return denial;
    },
  };
}

describe("github plugin", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults GitHub App permissions and user OAuth scopes to all available app access", () => {
    const plugin = githubPlugin();

    expect(plugin.manifest.capabilities).toBeUndefined();
    expect(plugin.manifest.oauth?.scope).toBeUndefined();
    expect(plugin.manifest.oauth?.treatEmptyScopeAsUnreported).toBe(true);
  });

  it("maps explicit GitHub App permissions and extra user OAuth scopes", () => {
    const plugin = githubPlugin({
      additionalUserScopes: ["read:org repo", "workflow", "repo"],
      appPermissions: {
        contents: "read",
        discussions: "read",
        issues: "write",
        pull_requests: "write",
        repository_projects: "admin",
      },
    });

    expect(plugin.manifest.capabilities).toEqual([
      "github.contents.read",
      "github.discussions.read",
      "github.issues.write",
      "github.pull-requests.write",
      "github.repository-projects.admin",
    ]);
    expect(plugin.manifest.oauth?.scope).toBe("read:org repo workflow");
  });

  it("rejects invalid explicit GitHub App permission levels", () => {
    expect(() =>
      githubPlugin({
        appPermissions: {
          issues: "admin" as "write",
        },
      }),
    ).toThrow('githubPlugin appPermissions.issues does not support "admin"');
  });

  it("rejects unknown explicit GitHub App permission levels", () => {
    expect(() =>
      githubPlugin({
        appPermissions: {
          issues: "owner" as "write",
        },
      }),
    ).toThrow(
      'githubPlugin appPermissions.issues must be "read", "write", or "admin".',
    );
  });

  it("rejects unsupported explicit GitHub App permission names", () => {
    expect(() =>
      githubPlugin({
        appPermissions: {
          "pull-requestz": "read",
        },
      }),
    ).toThrow(
      'githubPlugin appPermissions contains unsupported permission "pull-requestz".',
    );
  });

  it("serializes global git config writes during sandbox preparation", async () => {
    const started: string[] = [];
    const writes: Array<{ content: string | Uint8Array; path: string }> = [];
    let running = 0;
    let maxRunning = 0;

    const plugin = githubPlugin();
    const ctx: SandboxPrepareHookContext = {
      log: {
        error() {},
        info() {},
        warn() {},
      },
      plugin: { name: "github" },
      sandbox: {
        juniorRoot: "/vercel/sandbox/.junior",
        root: "/vercel/sandbox",
        async readFile() {
          return null;
        },
        async run(input) {
          expect(input.cmd).toBe("git");
          expect(input.args?.slice(0, 2)).toEqual(["config", "--global"]);

          started.push(String(input.args?.[2]));
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((resolve) => setTimeout(resolve, 0));
          running -= 1;

          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async writeFile(input) {
          writes.push({ content: input.content, path: input.path });
        },
      },
    };

    await plugin.hooks?.sandboxPrepare?.(ctx);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(
      "/vercel/sandbox/.junior/git-hooks/prepare-commit-msg",
    );
    expect(String(writes[0]?.content)).toContain(
      "Co-authored-by: $JUNIOR_GIT_COAUTHOR_NAME <$JUNIOR_GIT_COAUTHOR_EMAIL>",
    );
    expect(String(writes[0]?.content)).toContain(
      "Git author was not set to the resolved requester identity",
    );
    expect(started).toEqual([
      "core.hooksPath",
      "commit.gpgsign",
      "credential.helper",
      "http.emptyAuth",
    ]);
    expect(maxRunning).toBe(1);
  });

  it("injects requester author and Junior coauthor env only for resolved requester identity", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const before = beforeToolContext({
      email: "david@example.com",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "dcramer",
    });

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toBeUndefined();
    expect(before.env).toMatchObject({
      GIT_AUTHOR_NAME: "David Cramer",
      GIT_AUTHOR_EMAIL: "david@example.com",
      GIT_COMMITTER_NAME: "sentry-junior[bot]",
      GIT_COMMITTER_EMAIL: "bot@example.com",
      JUNIOR_GIT_AUTHOR_NAME: "David Cramer",
      JUNIOR_GIT_AUTHOR_EMAIL: "david@example.com",
      JUNIOR_GIT_COAUTHOR_NAME: "sentry-junior[bot]",
      JUNIOR_GIT_COAUTHOR_EMAIL: "bot@example.com",
    });
  });

  it("denies git commits when requester identity is an unresolved Slack id", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const before = beforeToolContext({
      fullName: "U039RR91S",
      userId: "U039RR91S",
      userName: "U039RR91S",
    });

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toContain("resolved requester name and email");
    expect(before.env).toEqual({});
  });

  it("denies git commits when requester display identity is synthetic unknown", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const before = beforeToolContext({
      email: "david@example.com",
      fullName: "unknown",
      userId: "U039RR91S",
      userName: "unknown",
    });

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toContain("resolved requester name and email");
    expect(before.env).toEqual({});
  });
});
