import { generateKeyPairSync } from "node:crypto";
import type { SandboxPrepareHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const pluginLog = {
  error() {},
  info() {},
  warn() {},
};

async function grantForEgress(input: { method: string; url: string }) {
  const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
  return await plugin.hooks?.grantForEgress?.({
    log: pluginLog,
    plugin: { name: "github" },
    request: {
      method: input.method,
      url: input.url,
    },
  });
}

function githubIssueCredentialContext(input: {
  actor?: { type: "system"; id: string } | { type: "user"; userId: string };
  credentialSubjectToken?: {
    accessToken: string;
    expiresAt?: number;
    refreshToken: string;
    scope?: string;
  };
  grant: { access: "read" | "write"; name: string; reason?: string };
  currentUserToken?: {
    accessToken: string;
    expiresAt?: number;
    refreshToken: string;
    scope?: string;
  };
}) {
  const currentUser = {
    userId: "U123",
    get: vi.fn(async () => input.currentUserToken),
    set: vi.fn(),
  };
  const credentialSubject = {
    userId: "U456",
    get: vi.fn(async () => input.credentialSubjectToken),
    set: vi.fn(),
  };
  return {
    actor: input.actor ?? { type: "user" as const, userId: "U123" },
    ...(input.credentialSubjectToken
      ? { credentialSubject: { type: "user" as const, userId: "U456" } }
      : {}),
    grant: input.grant,
    log: pluginLog,
    plugin: { name: "github" },
    tokens: {
      ...(input.actor?.type !== "system" ? { currentUser } : {}),
      ...(input.credentialSubjectToken ? { credentialSubject } : {}),
    },
  };
}

describe("github plugin", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
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

  it("accepts GitHub permission names without a local provider catalog", () => {
    const plugin = githubPlugin({
      appPermissions: {
        "new-provider-permission": "read",
      },
    });

    expect(plugin.manifest.capabilities).toEqual([
      "github.new-provider-permission.read",
    ]);
  });

  it("rejects malformed explicit GitHub App permission names", () => {
    expect(() =>
      githubPlugin({
        appPermissions: {
          "pull requests": "read",
        },
      }),
    ).toThrow(
      'githubPlugin appPermissions contains invalid permission "pull requests".',
    );
  });

  it("selects installation-read for GitHub reads and user-write for write URLs", async () => {
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://api.github.com/repos/getsentry/junior/issues/449",
      }),
    ).toMatchObject({
      name: "installation-read",
      access: "read",
      reason: "github.api-read",
    });
    expect(
      await grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/issues",
      }),
    ).toMatchObject({
      name: "user-write",
      access: "write",
      reason: "github.issue-create",
    });
  });

  it("uses Git smart HTTP write evidence over conflicting read evidence", async () => {
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior.git/git-receive-pack?service=git-upload-pack",
      }),
    ).toMatchObject({
      name: "user-write",
      access: "write",
      reason: "github.git-write",
    });
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior.git/git-upload-pack?service=git-receive-pack",
      }),
    ).toMatchObject({
      name: "user-write",
      access: "write",
      reason: "github.git-write",
    });
  });

  it("only treats Git smart HTTP service parameters as write evidence on Git paths", async () => {
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior.git/info/refs?service=git-receive-pack",
      }),
    ).toMatchObject({
      name: "user-write",
      access: "write",
      reason: "github.git-write",
    });
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior.git/info/refs?service=git-upload-pack",
      }),
    ).toMatchObject({
      name: "installation-read",
      access: "read",
      reason: "github.git-read",
    });
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior/releases/download/v1.0.0/archive.tar.gz?service=git-receive-pack",
      }),
    ).toMatchObject({
      name: "installation-read",
      access: "read",
      reason: "github.api-read",
    });
  });

  it("treats GitHub GraphQL GET as read and POST as write", async () => {
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://api.github.com/graphql",
      }),
    ).toMatchObject({
      name: "installation-read",
      access: "read",
      reason: "github.graphql-read",
    });
    expect(
      await grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
      }),
    ).toMatchObject({
      name: "user-write",
      access: "write",
      reason: "github.graphql-write",
    });
  });

  it("issues read-only GitHub App installation credentials from plugin-managed hooks", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_INSTALLATION_ID = "456";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return Response.json({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }),
    );

    const plugin = githubPlugin({
      appPermissions: {
        contents: "write",
        issues: "write",
      },
    });
    const result = await plugin.hooks?.issueCredential?.({
      actor: { type: "system", id: "scheduler" },
      grant: {
        name: "installation-read",
        access: "read",
        reason: "github.api-read",
      },
      log: pluginLog,
      plugin: { name: "github" },
      tokens: {},
    });

    expect(result).toMatchObject({
      type: "lease",
      lease: {
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer installation-token" },
          },
          {
            domain: "github.com",
          },
        ],
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/app/installations/456/access_tokens",
      body: {
        permissions: {
          contents: "read",
          issues: "read",
          metadata: "read",
        },
      },
    });
  });

  it("caches implicit GitHub App installation permissions", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_INSTALLATION_ID = "456";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (String(url).endsWith("/app/installations/456")) {
          return Response.json({
            permissions: {
              contents: "write",
              issues: "write",
              metadata: "read",
              pull_requests: "read",
              workflows: "write",
            },
          });
        }
        return Response.json({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }),
    );

    const plugin = githubPlugin();
    const ctx = {
      actor: { type: "system" as const, id: "scheduler" },
      grant: {
        name: "installation-read",
        access: "read" as const,
        reason: "github.api-read",
      },
      log: pluginLog,
      plugin: { name: "github" },
      tokens: {},
    };

    await plugin.hooks?.issueCredential?.(ctx);
    await plugin.hooks?.issueCredential?.(ctx);

    const permissionReads = requests.filter(
      (request) =>
        request.method === "GET" &&
        request.url === "https://api.github.com/app/installations/456",
    );
    const tokenRequests = requests.filter((request) =>
      request.url.endsWith("/app/installations/456/access_tokens"),
    );
    expect(permissionReads).toHaveLength(1);
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests.map((request) => request.body)).toEqual([
      {
        permissions: {
          contents: "read",
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
      },
      {
        permissions: {
          contents: "read",
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
      },
    ]);
  });

  it("requires user authorization context for user-write credentials", async () => {
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const missingActor = await plugin.hooks?.issueCredential?.({
      actor: { type: "system", id: "scheduler" },
      grant: { name: "user-write", access: "write" },
      log: pluginLog,
      plugin: { name: "github" },
      tokens: {},
    });

    expect(missingActor).toEqual({
      type: "needed",
      message:
        "GitHub write access requires a current user or delegated user credential subject.",
    });

    const missingToken = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        grant: { name: "user-write", access: "write" },
      }),
    );
    expect(missingToken).toMatchObject({
      type: "needed",
      authorization: {
        type: "oauth",
        provider: "github",
        scope: "repo",
      },
    });
  });

  it("issues user-write credentials from stored current-user tokens", async () => {
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.issue-create",
        },
        currentUserToken: {
          accessToken: "user-token",
          expiresAt: Date.now() + 60 * 60_000,
          refreshToken: "refresh-token",
          scope: "repo",
        },
      }),
    );

    expect(result).toMatchObject({
      type: "lease",
      lease: {
        authorization: {
          type: "oauth",
          provider: "github",
          scope: "repo",
        },
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer user-token" },
          },
          {
            domain: "github.com",
            headers: {
              Authorization: expect.stringMatching(/^Basic /),
            },
          },
        ],
      },
    });
  });

  it("issues user-write credentials from delegated credential subject tokens", async () => {
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        actor: { type: "system", id: "scheduler" },
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.issue-create",
        },
        credentialSubjectToken: {
          accessToken: "delegated-token",
          expiresAt: Date.now() + 60 * 60_000,
          refreshToken: "delegated-refresh-token",
          scope: "repo",
        },
      }),
    );

    expect(result).toMatchObject({
      type: "lease",
      lease: {
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer delegated-token" },
          },
          {
            domain: "github.com",
            headers: {
              Authorization: expect.stringMatching(/^Basic /),
            },
          },
        ],
      },
    });
  });

  it("requires reauthorization when GitHub user token refresh is rejected", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "bad_refresh_token" }, { status: 400 }),
      ),
    );

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.issue-create",
        },
        currentUserToken: {
          accessToken: "stale-token",
          expiresAt: Date.now() + 60_000,
          refreshToken: "stale-refresh-token",
          scope: "repo",
        },
      }),
    );

    expect(result).toMatchObject({
      type: "needed",
      authorization: {
        type: "oauth",
        provider: "github",
        scope: "repo",
      },
    });
  });

  it("surfaces operational GitHub user token refresh failures", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "server_error" }, { status: 500 }),
      ),
    );

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    await expect(
      plugin.hooks?.issueCredential?.(
        githubIssueCredentialContext({
          grant: {
            name: "user-write",
            access: "write",
            reason: "github.issue-create",
          },
          currentUserToken: {
            accessToken: "stale-token",
            expiresAt: Date.now() + 60_000,
            refreshToken: "stale-refresh-token",
            scope: "repo",
          },
        }),
      ),
    ).rejects.toThrow("GitHub user token refresh failed: 500 server_error");
  });

  it("prepares git attribution hooks and sandbox git config", async () => {
    const started: string[] = [];
    const writes: Array<{ content: string | Uint8Array; path: string }> = [];

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
