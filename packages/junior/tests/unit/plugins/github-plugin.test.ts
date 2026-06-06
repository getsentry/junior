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
    expect(started).toEqual([
      "core.hooksPath",
      "commit.gpgsign",
      "credential.helper",
      "http.emptyAuth",
    ]);
    expect(maxRunning).toBe(1);
  });

  it("injects commit coauthor env only for resolved requester identity", () => {
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
      GIT_AUTHOR_NAME: "sentry-junior[bot]",
      GIT_AUTHOR_EMAIL: "bot@example.com",
      JUNIOR_GIT_AUTHOR_NAME: "sentry-junior[bot]",
      JUNIOR_GIT_AUTHOR_EMAIL: "bot@example.com",
      JUNIOR_GIT_COAUTHOR_NAME: "David Cramer",
      JUNIOR_GIT_COAUTHOR_EMAIL: "david@example.com",
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
