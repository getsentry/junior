import { generateKeyPairSync } from "node:crypto";
import {
  EgressAuthRequired,
  type PluginStoredTokens,
  type SandboxPrepareHookContext,
} from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubPlugin } from "../src/index";
import { mswServer } from "./msw";

const ORIGINAL_ENV = { ...process.env };

const db = {};

class TestTokenStore {
  private refreshLock = Promise.resolve();
  private tokens = new Map<string, PluginStoredTokens>();

  async get(
    userId: string,
    provider: string,
  ): Promise<PluginStoredTokens | undefined> {
    const tokens = this.tokens.get(this.key(userId, provider));
    return tokens ? structuredClone(tokens) : undefined;
  }

  async set(
    userId: string,
    provider: string,
    tokens: PluginStoredTokens,
  ): Promise<void> {
    this.tokens.set(this.key(userId, provider), structuredClone(tokens));
  }

  async withRefresh<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.refreshLock;
    let release: () => void;
    this.refreshLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release!();
    }
  }

  private key(userId: string, provider: string): string {
    return `${provider}:${userId}`;
  }
}

type TestActor = {
  email?: string;
  fullName?: string;
  platform?: string;
  teamId?: string;
  userId?: string;
  userName?: string;
};

function beforeToolContext(actor: TestActor, actors?: TestActor[]) {
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
      db,
      actor,
      ...(actors ? { actors } : {}),
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

/**
 * Recover the exact prepare-commit-msg script sandboxPrepare writes and stage
 * it with a seeded commit message file, so tests execute the real generated
 * bash instead of asserting on script text.
 */
async function prepareCommitMsgHookFixture(initialMessage: string) {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");

  let hookScript: string | undefined;
  await githubPlugin().hooks?.sandboxPrepare?.({
    db,
    log: pluginLog,
    plugin: { name: "github" },
    sandbox: {
      juniorRoot: "/vercel/sandbox/.junior",
      root: "/vercel/sandbox",
      async readFile() {
        return null;
      },
      async run() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async writeFile(input) {
        hookScript = String(input.content);
      },
    },
  } as SandboxPrepareHookContext);
  if (!hookScript) {
    throw new Error("prepare-commit-msg hook was not written");
  }

  const dir = mkdtempSync(join(tmpdir(), "junior-github-hook-"));
  const hookPath = join(dir, "prepare-commit-msg");
  const messagePath = join(dir, "COMMIT_EDITMSG");
  writeFileSync(hookPath, hookScript);
  chmodSync(hookPath, 0o755);
  writeFileSync(messagePath, initialMessage);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "sentry-junior[bot]",
    GIT_AUTHOR_EMAIL: "bot@example.com",
    JUNIOR_GIT_AUTHOR_NAME: "sentry-junior[bot]",
    JUNIOR_GIT_AUTHOR_EMAIL: "bot@example.com",
    JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS:
      "Co-Authored-By: Bob Steer <bob@example.com>\nCo-Authored-By: Carol Steer <carol@example.com>",
  };

  return {
    dir,
    hookPath,
    messagePath,
    runHook: () => spawnSync("bash", [hookPath, messagePath], { env }),
  };
}

type CapturedRequest = {
  body?: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
};

async function captureRequest(request: Request): Promise<CapturedRequest> {
  const text = await request.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    ...(text ? { body } : {}),
  };
}

function cloneStateValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function mockGitHubInstallationApi(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  mswServer.use(
    http.get(
      "https://api.github.com/app/installations/:installationId",
      async ({ request }) => {
        requests.push(await captureRequest(request));
        return HttpResponse.json({
          permissions: {
            contents: "write",
            issues: "write",
            metadata: "read",
            pull_requests: "read",
            workflows: "write",
          },
        });
      },
    ),
    http.post(
      "https://api.github.com/app/installations/:installationId/access_tokens",
      async ({ request }) => {
        requests.push(await captureRequest(request));
        return HttpResponse.json({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      },
    ),
  );
  return requests;
}

function mockGitHubUserApi(input?: {
  payload?: Record<string, unknown>;
  status?: number;
}): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  mswServer.use(
    http.get("https://api.github.com/user", async ({ request }) => {
      requests.push(await captureRequest(request));
      return HttpResponse.json(
        input?.payload ?? {
          id: 12345,
          login: "actor",
          html_url: "https://github.com/actor",
        },
        { status: input?.status ?? 200 },
      );
    }),
  );
  return requests;
}

function mockGitHubRefresh(
  status: number,
  payload: Record<string, unknown>,
): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  mswServer.use(
    http.post(
      "https://github.com/login/oauth/access_token",
      async ({ request }) => {
        requests.push(await captureRequest(request));
        return HttpResponse.json(payload, { status });
      },
    ),
  );
  return requests;
}

async function grantForEgress(input: {
  bodyText?: string;
  method: string;
  operation?: string;
  url: string;
}) {
  const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
  return await plugin.hooks?.grantForEgress?.({
    db,
    log: pluginLog,
    plugin: { name: "github" },
    request: {
      ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
      method: input.method,
      ...(input.operation ? { operation: input.operation } : {}),
      url: input.url,
    },
  });
}

function githubToolsContext(input?: {
  actor?: TestActor;
  conversationId?: string;
  egressFetch?: (request: {
    operation: string;
    provider: string;
    request: Request;
  }) => Promise<Response>;
  stateSet?: (input: { key: string; value: unknown }) => Promise<void> | void;
}) {
  const conversationId = input?.conversationId ?? "local:test:github-tool";
  const state = new Map<string, unknown>();
  const requests: Array<{
    operation: string;
    provider: string;
    request: Request;
  }> = [];
  return {
    db,
    log: pluginLog,
    plugin: { name: "github" },
    ...(input?.actor ? { actor: input.actor } : {}),
    conversationId,
    destination: { platform: "local" as const, conversationId },
    source: {
      platform: "local" as const,
      type: "priv" as const,
      conversationId,
    },
    embedder: {},
    egress: {
      async fetch(request: {
        operation: string;
        provider: string;
        request: Request;
      }) {
        requests.push(request);
        if (input?.egressFetch) {
          return await input.egressFetch(request);
        }
        return new Response(
          JSON.stringify({
            number: 660,
            html_url: "https://github.com/getsentry/junior/issues/660",
          }),
          { status: 201 },
        );
      },
    },
    model: {},
    state: {
      async delete(key: string) {
        state.delete(key);
      },
      async get(key: string) {
        return cloneStateValue(state.get(key));
      },
      async set(key: string, value: unknown) {
        await input?.stateSet?.({ key, value });
        state.set(key, cloneStateValue(value));
      },
      async setIfNotExists(key: string, value: unknown) {
        if (state.has(key)) {
          return false;
        }
        state.set(key, cloneStateValue(value));
        return true;
      },
      async withLock<T>(
        _key: string,
        _ttlMs: number,
        callback: () => Promise<T>,
      ) {
        return await callback();
      },
    },
    egressRequests() {
      return requests;
    },
    setState(key: string, value: unknown) {
      state.set(key, cloneStateValue(value));
    },
  };
}

function githubIssueCredentialContext(input: {
  actor?:
    | { platform: "system"; name: string }
    | { type: "user"; userId: string };
  credentialSubjectToken?: {
    account?: { id: string; label?: string; url?: string };
    accessToken: string;
    expiresAt?: number;
    refreshToken: string;
    refreshTokenExpiresAt?: number;
    scope?: string;
  };
  grant: {
    access: "read" | "write";
    leaseScope?: string;
    name: string;
    reason?: string;
  };
  currentUserToken?: {
    account?: { id: string; label?: string; url?: string };
    accessToken: string;
    expiresAt?: number;
    refreshToken: string;
    refreshTokenExpiresAt?: number;
    scope?: string;
  };
  currentUserTokenReads?: Array<
    | {
        account?: { id: string; label?: string; url?: string };
        accessToken: string;
        expiresAt?: number;
        refreshToken: string;
        refreshTokenExpiresAt?: number;
        scope?: string;
      }
    | undefined
  >;
}) {
  const currentUserReads = [...(input.currentUserTokenReads ?? [])];
  const currentUser = {
    userId: "U123",
    get: vi.fn(async () =>
      currentUserReads.length
        ? currentUserReads.shift()
        : input.currentUserToken,
    ),
    set: vi.fn(),
    withRefresh: vi.fn(async (callback) => await callback()),
  };
  const credentialSubject = {
    userId: "U456",
    get: vi.fn(async () => input.credentialSubjectToken),
    set: vi.fn(),
    withRefresh: vi.fn(async (callback) => await callback()),
  };
  const actor = input.actor ?? { type: "user" as const, userId: "U123" };
  return {
    actor,
    ...(input.credentialSubjectToken
      ? { credentialSubject: { type: "user" as const, userId: "U456" } }
      : {}),
    grant: input.grant,
    db,
    log: pluginLog,
    plugin: { name: "github" },
    tokens: {
      ...(actor.platform !== "system" ? { currentUser } : {}),
      ...(input.credentialSubjectToken ? { credentialSubject } : {}),
    },
  };
}

describe("github plugin", () => {
  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses the sandbox-provided curl implementation", () => {
    expect(githubPlugin().manifest?.runtimeDependencies).toEqual([
      { type: "system", package: "gh" },
      { type: "system", package: "jq" },
    ]);
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

  it("selects installation identity for reads and typed resource writes", async () => {
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
        operation: "github.issue.create",
        url: "https://api.github.com/repos/getsentry/junior/issues",
      }),
    ).toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
    expect(
      await grantForEgress({
        method: "POST",
        operation: "github.pull.create",
        url: "https://api.github.com/repos/getsentry/junior/pulls",
      }),
    ).toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/forks",
      }),
    ).rejects.toThrow(
      "GitHub write request is not an explicitly allowed Junior operation.",
    );
  });

  it("uses requesting-user credentials for GitHub user-attachment uploads", async () => {
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://uploads.github.com/user-attachments/assets?name=screenshot.png&content_type=image%2Fpng&repository_id=123",
      }),
    ).resolves.toMatchObject({
      name: "user-write",
      access: "write",
      reason: "github.asset-upload",
      requirements: [
        "requesting GitHub user permission to perform this operation",
      ],
    });
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://uploads.github.com/unrelated",
      }),
    ).rejects.toThrow(
      "GitHub write request is not an explicitly allowed Junior operation.",
    );
  });

  it("maintains the workflow dispatch permission boundary", async () => {
    expect(
      await grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/actions/workflows/release.yml/dispatches",
      }),
    ).toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/actions/runs/123/rerun",
      }),
    ).rejects.toThrow(
      "GitHub write request is not an explicitly allowed Junior operation.",
    );
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/actions/runs/123/cancel",
      }),
    ).rejects.toThrow(
      "GitHub write request is not an explicitly allowed Junior operation.",
    );
  });

  it("denies raw GitHub issue creation outside the typed createIssue operation", async () => {
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/issues",
      }),
    ).rejects.toThrow("must use the github_createIssue tool");
  });

  it("denies raw GitHub pull request creation outside the typed createPullRequest operation", async () => {
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/pulls",
      }),
    ).rejects.toThrow("must use the github_createPullRequest tool");
  });

  it("creates issues with deterministic requester attribution", async () => {
    const ctx = githubToolsContext({
      actor: {
        fullName: "David Cramer",
        platform: "slack",
        teamId: "T1",
        userId: "U1",
      },
      conversationId: "slack:C123:1712345.0001",
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed issue",
          body: "Issue body",
          labels: ["bug", "high-priority"],
        },
        { toolCallId: "call-create-issue" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      target: "createIssue",
      data: {
        number: 660,
        url: "https://github.com/getsentry/junior/issues/660",
      },
      number: 660,
      url: "https://github.com/getsentry/junior/issues/660",
    });

    expect(ctx.egressRequests()).toHaveLength(1);
    const request = ctx.egressRequests()[0];
    expect(request).toMatchObject({
      provider: "github",
      operation: "github.issue.create",
    });
    expect(request?.request.method).toBe("POST");
    expect(request?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues",
    );
    expect(
      Object.fromEntries(request?.request.headers.entries() ?? []),
    ).toEqual(
      expect.objectContaining({
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      }),
    );
    await expect(request?.request.json()).resolves.toEqual({
      title: "Typed issue",
      body: "Issue body\n\n<!-- junior-request-attribution:start -->\nRequested by **David Cramer** via Junior.\n<!-- junior-request-attribution:end -->",
      labels: ["bug", "high-priority"],
    });
  });

  it("adds a Sentry session link to issue footers when configured", async () => {
    process.env.SENTRY_DSN = "https://public@o450000.ingest.sentry.io/12345";
    process.env.SENTRY_ORG_SLUG = "acme";
    const ctx = githubToolsContext({
      conversationId: "slack:C123:1712345.0001",
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;

    await tool?.execute?.(
      {
        repo: "getsentry/junior",
        title: "Typed issue",
      },
      { toolCallId: "call-create-issue-with-session-link" },
    );

    const request = ctx.egressRequests()[0];
    await expect(request?.request.json()).resolves.toMatchObject({
      body: `<!-- junior-session-footer:start -->

--

[View Junior Session in Sentry](https://acme.sentry.io/explore/conversations/slack%3AC123%3A1712345.0001/?project=12345)

<!-- junior-session-footer:end -->`,
    });
  });

  it("replaces an existing Junior issue footer before creating issues", async () => {
    const ctx = githubToolsContext({
      conversationId: "local:test:new-conversation",
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;

    await tool?.execute?.(
      {
        repo: "getsentry/junior",
        title: "Typed issue",
        body: `Issue body

<!-- junior-session-footer:start -->

---
Created by Junior.
Conversation: \`local:test:old-conversation\`

<!-- junior-session-footer:end -->`,
      },
      { toolCallId: "call-replace-footer" },
    );

    const request = ctx.egressRequests()[0];
    await expect(request?.request.json()).resolves.toMatchObject({
      body: "Issue body",
    });
  });

  it("returns the stored issue result when a createIssue tool call is retried", async () => {
    const ctx = githubToolsContext();
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;
    const input = {
      repo: "getsentry/junior",
      title: "Typed issue",
    };

    await expect(
      tool?.execute?.(input, { toolCallId: "call-idempotent-create" }),
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      target: "createIssue",
      number: 660,
      url: "https://github.com/getsentry/junior/issues/660",
    });
    await expect(
      tool?.execute?.(input, { toolCallId: "call-idempotent-create" }),
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      target: "createIssue",
      number: 660,
      url: "https://github.com/getsentry/junior/issues/660",
    });

    expect(ctx.egressRequests()).toHaveLength(1);
  });

  it("refuses to duplicate issue creation after an uncertain pending attempt", async () => {
    const ctx = githubToolsContext();
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;
    ctx.setState("createIssue:local:test:github-tool:call-pending-create", {
      status: "pending",
      createdAtMs: Date.now(),
    });

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed issue",
        },
        { toolCallId: "call-pending-create" },
      ),
    ).rejects.toThrow("refusing to create a duplicate issue");

    expect(ctx.egressRequests()).toHaveLength(0);
  });

  it("keeps pending idempotency state when GitHub response handling fails", async () => {
    const ctx = githubToolsContext({
      egressFetch: async () => new Response("created", { status: 201 }),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;
    const input = {
      repo: "getsentry/junior",
      title: "Typed issue",
    };

    await expect(
      tool?.execute?.(input, { toolCallId: "call-lost-response" }),
    ).rejects.toThrow("invalid response");
    await expect(
      tool?.execute?.(input, { toolCallId: "call-lost-response" }),
    ).rejects.toThrow("refusing to create a duplicate issue");

    expect(ctx.egressRequests()).toHaveLength(1);
  });

  it("clears pending idempotency state after definitive GitHub rejection", async () => {
    let attempts = 0;
    const ctx = githubToolsContext({
      egressFetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ message: "Invalid title" }), {
            status: 422,
          });
        }
        return new Response(
          JSON.stringify({
            number: 660,
            html_url: "https://github.com/getsentry/junior/issues/660",
          }),
          { status: 201 },
        );
      },
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;
    const input = {
      repo: "getsentry/junior",
      title: "Typed issue",
    };

    await expect(
      tool?.execute?.(input, { toolCallId: "call-definitive-rejection" }),
    ).rejects.toThrow("HTTP 422");
    await expect(
      tool?.execute?.(input, { toolCallId: "call-definitive-rejection" }),
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      target: "createIssue",
      number: 660,
      url: "https://github.com/getsentry/junior/issues/660",
    });

    expect(ctx.egressRequests()).toHaveLength(2);
  });

  it("clears pending idempotency state after GitHub authorization pauses", async () => {
    let attempts = 0;
    const ctx = githubToolsContext({
      egressFetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new EgressAuthRequired("GitHub authorization required.", {
            authorization: {
              provider: "github",
              scope: "repo",
              type: "oauth",
            },
          });
        }
        return new Response(
          JSON.stringify({
            number: 660,
            html_url: "https://github.com/getsentry/junior/issues/660",
          }),
          { status: 201 },
        );
      },
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;
    const input = {
      repo: "getsentry/junior",
      title: "Typed issue",
    };

    await expect(
      tool?.execute?.(input, { toolCallId: "call-auth-required" }),
    ).rejects.toThrow("GitHub authorization required");
    await expect(
      tool?.execute?.(input, { toolCallId: "call-auth-required" }),
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      target: "createIssue",
      number: 660,
      url: "https://github.com/getsentry/junior/issues/660",
    });

    expect(ctx.egressRequests()).toHaveLength(2);
  });

  it("keeps pending idempotency state after ambiguous GitHub server failure", async () => {
    const ctx = githubToolsContext({
      egressFetch: async () =>
        new Response(JSON.stringify({ message: "Server error" }), {
          status: 500,
        }),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;
    const input = {
      repo: "getsentry/junior",
      title: "Typed issue",
    };

    await expect(
      tool?.execute?.(input, { toolCallId: "call-server-error" }),
    ).rejects.toThrow("HTTP 500");
    await expect(
      tool?.execute?.(input, { toolCallId: "call-server-error" }),
    ).rejects.toThrow("refusing to create a duplicate issue");

    expect(ctx.egressRequests()).toHaveLength(1);
  });

  it("keeps pending idempotency state after ambiguous GitHub throttling", async () => {
    const ctx = githubToolsContext({
      egressFetch: async () =>
        new Response(JSON.stringify({ message: "Rate limited" }), {
          status: 403,
        }),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;
    const input = {
      repo: "getsentry/junior",
      title: "Typed issue",
    };

    await expect(
      tool?.execute?.(input, { toolCallId: "call-rate-limited" }),
    ).rejects.toThrow("HTTP 403");
    await expect(
      tool?.execute?.(input, { toolCallId: "call-rate-limited" }),
    ).rejects.toThrow("refusing to create a duplicate issue");

    expect(ctx.egressRequests()).toHaveLength(1);
  });

  it("fail-closes retries when completed storage fails after creation", async () => {
    let setCalls = 0;
    const ctx = githubToolsContext({
      stateSet: () => {
        setCalls += 1;
        if (setCalls === 2) {
          throw new Error("state unavailable");
        }
      },
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createIssue;

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed issue",
        },
        { toolCallId: "call-completed-storage-fails" },
      ),
    ).rejects.toThrow(
      "GitHub issue was created, but Junior could not persist the completed issue state.",
    );
    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed issue",
        },
        { toolCallId: "call-completed-storage-fails" },
      ),
    ).rejects.toThrow("refusing to create a duplicate issue");

    expect(ctx.egressRequests()).toHaveLength(1);
  });

  it("creates pull requests with deterministic requester attribution", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const ctx = githubToolsContext({
      actor: {
        fullName: "David Cramer",
        platform: "slack",
        teamId: "T1",
        userId: "U1",
      },
      conversationId: "slack:C123:1712345.0001",
      egressFetch: async () =>
        new Response(
          JSON.stringify({
            number: 691,
            html_url: "https://github.com/getsentry/junior/pull/691",
          }),
          { status: 201 },
        ),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createPullRequest;

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed PR",
          head: "dcramer/gh-660-pr-create",
          base: "main",
          body: "PR body",
          draft: true,
        },
        { toolCallId: "call-create-pull-request" },
      ),
    ).resolves.toMatchObject({
      number: 691,
      subscribable: {
        label: "GitHub PR getsentry/junior#691",
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#691",
        suggestedEvents: [
          "checks.failed",
          "comment.created",
          "review.changes_requested",
          "review.commented",
          "review_comment.created",
          "state.merged",
          "state.closed_unmerged",
        ],
        supportedEvents: [
          "checks.failed",
          "checks.recovered",
          "comment.created",
          "review.approved",
          "review.changes_requested",
          "review.commented",
          "review_comment.created",
          "state.merged",
          "state.closed_unmerged",
        ],
        type: "pull_request",
      },
      url: "https://github.com/getsentry/junior/pull/691",
    });

    expect(ctx.egressRequests()).toHaveLength(1);
    const request = ctx.egressRequests()[0];
    expect(request).toMatchObject({
      provider: "github",
      operation: "github.pull.create",
    });
    expect(request?.request.method).toBe("POST");
    expect(request?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/pulls",
    );
    expect(
      Object.fromEntries(request?.request.headers.entries() ?? []),
    ).toEqual(
      expect.objectContaining({
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      }),
    );
    await expect(request?.request.json()).resolves.toEqual({
      title: "Typed PR",
      head: "dcramer/gh-660-pr-create",
      base: "main",
      body: "PR body\n\n<!-- junior-request-attribution:start -->\nRequested by **David Cramer** via Junior.\n<!-- junior-request-attribution:end -->",
      draft: true,
    });
  });

  it("omits pull request subscription hints when GitHub webhooks are not configured", async () => {
    const ctx = githubToolsContext({
      egressFetch: async () =>
        new Response(
          JSON.stringify({
            number: 691,
            html_url: "https://github.com/getsentry/junior/pull/691",
          }),
          { status: 201 },
        ),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createPullRequest;

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed PR",
          head: "dcramer/gh-660-pr-create",
          base: "main",
        },
        { toolCallId: "call-create-pull-request-without-webhooks" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: "success",
      target: "createPullRequest",
      number: 691,
      url: "https://github.com/getsentry/junior/pull/691",
    });
  });

  it("adds a Sentry session link to pull request footers when configured", async () => {
    process.env.SENTRY_DSN = "https://public@o450000.ingest.sentry.io/12345";
    process.env.SENTRY_ORG_SLUG = "acme";
    const ctx = githubToolsContext({
      conversationId: "slack:C123:1712345.0001",
      egressFetch: async () =>
        new Response(
          JSON.stringify({
            number: 691,
            html_url: "https://github.com/getsentry/junior/pull/691",
          }),
          { status: 201 },
        ),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createPullRequest;

    await tool?.execute?.(
      {
        repo: "getsentry/junior",
        title: "Typed PR",
        head: "dcramer/gh-660-pr-create",
        base: "main",
        body: "PR body",
      },
      { toolCallId: "call-create-pull-request-with-session-link" },
    );

    const request = ctx.egressRequests()[0];
    await expect(request?.request.json()).resolves.toMatchObject({
      body: `PR body

<!-- junior-session-footer:start -->

--

[View Junior Session in Sentry](https://acme.sentry.io/explore/conversations/slack%3AC123%3A1712345.0001/?project=12345)

<!-- junior-session-footer:end -->`,
    });
  });

  it("returns the stored pull request result when a createPullRequest tool call is retried", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const ctx = githubToolsContext({
      egressFetch: async () =>
        new Response(
          JSON.stringify({
            number: 691,
            html_url: "https://github.com/getsentry/junior/pull/691",
          }),
          { status: 201 },
        ),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createPullRequest;
    const input = {
      repo: "getsentry/junior",
      title: "Typed PR",
      head: "dcramer/gh-660-pr-create",
      base: "main",
    };

    await expect(
      tool?.execute?.(input, { toolCallId: "call-idempotent-pr-create" }),
    ).resolves.toMatchObject({
      number: 691,
      subscribable: {
        resourceRef: "github:pull_request:getsentry/junior#691",
      },
      url: "https://github.com/getsentry/junior/pull/691",
    });
    await expect(
      tool?.execute?.(
        {
          ...input,
          repo: "getsentry/other",
        },
        { toolCallId: "call-idempotent-pr-create" },
      ),
    ).resolves.toMatchObject({
      number: 691,
      subscribable: {
        resourceRef: "github:pull_request:getsentry/junior#691",
      },
      url: "https://github.com/getsentry/junior/pull/691",
    });

    expect(ctx.egressRequests()).toHaveLength(1);
  });

  it("returns legacy stored pull request results without stored input", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const ctx = githubToolsContext();
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createPullRequest;
    ctx.setState(
      "createPullRequest:local:test:github-tool:call-legacy-pr-create",
      {
        status: "completed",
        createdAtMs: Date.now(),
        number: 691,
        url: "https://github.com/getsentry/junior/pull/691",
      },
    );

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed PR",
          head: "dcramer/gh-660-pr-create",
          base: "main",
        },
        { toolCallId: "call-legacy-pr-create" },
      ),
    ).resolves.toMatchObject({
      number: 691,
      subscribable: {
        resourceRef: "github:pull_request:getsentry/junior#691",
      },
      url: "https://github.com/getsentry/junior/pull/691",
    });

    expect(ctx.egressRequests()).toHaveLength(0);
  });

  it("refuses legacy pending pull request idempotency state", async () => {
    const ctx = githubToolsContext();
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createPullRequest;
    ctx.setState(
      "createPullRequest:local:test:github-tool:call-legacy-pending-pr-create",
      {
        status: "pending",
        createdAtMs: Date.now(),
      },
    );

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/junior",
          title: "Typed PR",
          head: "dcramer/gh-660-pr-create",
          base: "main",
        },
        { toolCallId: "call-legacy-pending-pr-create" },
      ),
    ).rejects.toThrow("refusing to create a duplicate pull request");

    expect(ctx.egressRequests()).toHaveLength(0);
  });

  it("surfaces GitHub pull request validation error details", async () => {
    const ctx = githubToolsContext({
      egressFetch: async () =>
        new Response(
          JSON.stringify({
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                field: "base",
                code: "invalid",
              },
            ],
          }),
          { status: 422 },
        ),
    });
    const plugin = githubPlugin();
    const tool = plugin.hooks?.tools?.(ctx as any)?.createPullRequest;

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/ops",
          title: "Typed PR",
          head: "inc-2297-eap-items-consumer-high-performance",
          base: "main",
        },
        { toolCallId: "call-invalid-pr-base" },
      ),
    ).rejects.toThrow(
      "GitHub pull request creation failed with HTTP 422: Validation Failed: resource=PullRequest field=base code=invalid",
    );

    await expect(
      tool?.execute?.(
        {
          repo: "getsentry/ops",
          title: "Typed PR",
          head: "inc-2297-eap-items-consumer-high-performance",
          base: "master",
        },
        { toolCallId: "call-invalid-pr-base" },
      ),
    ).rejects.toThrow(
      "GitHub pull request creation failed with HTTP 422: Validation Failed: resource=PullRequest field=base code=invalid",
    );

    expect(ctx.egressRequests()).toHaveLength(2);
  });

  it("uses Git smart HTTP write evidence over conflicting read evidence", async () => {
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior.git/git-receive-pack?service=git-upload-pack",
      }),
    ).toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior.git/git-upload-pack?service=git-receive-pack",
      }),
    ).toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
  });

  it("selects repository-scoped installation identity for Git push discovery", async () => {
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://github.com/getsentry/junior.git/info/refs?service=git-receive-pack",
      }),
    ).toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
  });

  it("selects user-read for GitHub user identity requests", async () => {
    expect(
      await grantForEgress({
        method: "GET",
        url: "https://api.github.com/user",
      }),
    ).toMatchObject({
      name: "user-read",
      access: "read",
      reason: "github.user-read",
    });
  });

  it("only treats Git smart HTTP service parameters as grant evidence on Git paths", async () => {
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

  it("treats GitHub GraphQL GET as read and denies ambiguous POST", async () => {
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
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
      }),
    ).rejects.toThrow("GraphQL mutations are not enabled");
  });

  it("selects installation-read for GitHub GraphQL read operations", async () => {
    expect(
      await grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: JSON.stringify({
          query: `query IssueList {
            repository(owner: "getsentry", name: "junior-prod") {
              issues(first: 20) { nodes { number title } }
            }
          }`,
        }),
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
        bodyText: JSON.stringify({
          query: "{ viewer { login } }",
        }),
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
        bodyText: JSON.stringify({
          query:
            'query SearchIssues { search(query: "mutation subscription", type: ISSUE, first: 1) { nodes { ... on Issue { number } } } }',
        }),
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
        bodyText: JSON.stringify({
          operationName: "ReadIssues",
          query:
            'query ReadIssues { repository(owner: "getsentry", name: "junior-prod") { issues(first: 1) { nodes { number } } } } mutation CreateIssue { createIssue(input: {repositoryId: "repo", title: "test"}) { issue { number } } }',
        }),
      }),
    ).toMatchObject({
      name: "installation-read",
      access: "read",
      reason: "github.graphql-read",
    });
  });

  it("denies GitHub GraphQL mutations and unparseable bodies", async () => {
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: JSON.stringify({
          query: `mutation AddIssueComment {
            addComment(input: {subjectId: "I_kwDO", body: "test"}) {
              clientMutationId
            }
          }`,
        }),
      }),
    ).rejects.toThrow("GraphQL mutations are not enabled");
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: JSON.stringify({
          query:
            "fragment prFields on PullRequest { number } mutation UpdatePullRequest($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { pullRequest { ...prFields } } }",
        }),
      }),
    ).rejects.toThrow("GraphQL mutations are not enabled");
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: "{",
      }),
    ).rejects.toThrow("GraphQL mutations are not enabled");
  });

  it("denies GraphQL createIssue mutations from raw egress", async () => {
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: JSON.stringify({
          operationName: "CreateIssue",
          query:
            'query ReadIssues { repository(owner: "getsentry", name: "junior-prod") { issues(first: 1) { nodes { number } } } } mutation CreateIssue { createIssue(input: {repositoryId: "repo", title: "test"}) { issue { number } } }',
        }),
      }),
    ).rejects.toThrow("must use the github_createIssue tool");
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: JSON.stringify({
          operationName: "CreateIssue",
          query:
            'fragment createIssueFields on Mutation { createIssue(input: {repositoryId: "repo", title: "test"}) { issue { number } } } mutation CreateIssue { ...createIssueFields }',
        }),
      }),
    ).rejects.toThrow("must use the github_createIssue tool");
  });

  it("denies GraphQL createPullRequest mutations from raw egress", async () => {
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: JSON.stringify({
          operationName: "OpenPullRequest",
          query:
            'query ReadPulls { repository(owner: "getsentry", name: "junior") { pullRequests(first: 1) { nodes { number } } } } mutation OpenPullRequest($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number } } }',
        }),
      }),
    ).rejects.toThrow("must use the github_createPullRequest tool");
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/graphql",
        bodyText: JSON.stringify({
          operationName: "OpenPullRequest",
          query:
            'fragment createPullRequestFields on Mutation { createPullRequest(input: {repositoryId: "repo", title: "test", headRefName: "branch", baseRefName: "main"}) { pullRequest { number } } } mutation OpenPullRequest { ...createPullRequestFields }',
        }),
      }),
    ).rejects.toThrow("must use the github_createPullRequest tool");
  });

  it("keeps unsupported repository writes outside the allowlist", async () => {
    await expect(
      grantForEgress({
        method: "PATCH",
        url: "https://api.github.com/repos/getsentry/junior/issues/780",
      }),
    ).resolves.toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/git/blobs",
      }),
    ).rejects.toThrow(
      "GitHub write request is not an explicitly allowed Junior operation.",
    );
  });

  it("separates pull request lifecycle writes from human review identity", async () => {
    await expect(
      grantForEgress({
        method: "PATCH",
        url: "https://api.github.com/repos/getsentry/junior/pulls/780",
      }),
    ).resolves.toMatchObject({
      name: "installation-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.installation-write",
    });
    await expect(
      grantForEgress({
        method: "POST",
        url: "https://api.github.com/repos/getsentry/junior/pulls/780/reviews",
      }),
    ).resolves.toMatchObject({
      name: "user-write",
      access: "write",
      leaseScope: "repository:getsentry/junior",
      reason: "github.user-write",
      requirements: [
        "requesting GitHub user permission to perform this operation",
      ],
    });
  });

  it("preserves installed App permissions on repository-scoped write credentials", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_INSTALLATION_ID = "456";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    const requests = mockGitHubInstallationApi();
    const plugin = githubPlugin({
      appPermissions: {
        contents: "write",
      },
    });

    const result = await plugin.hooks?.issueCredential?.({
      actor: { platform: "system", name: "resource-event" },
      grant: {
        name: "installation-write",
        access: "write",
        leaseScope: "repository:getsentry/junior",
        reason: "github.installation-write",
      },
      db,
      log: pluginLog,
      plugin: { name: "github" },
      tokens: {},
    });

    expect(result?.type).toBe("lease");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "https://api.github.com/app/installations/456/access_tokens",
      method: "POST",
      body: {
        repositories: ["junior"],
      },
      headers: expect.any(Object),
    });
  });

  it("issues read-only GitHub App installation credentials from plugin hooks", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_INSTALLATION_ID = "456";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

    const requests = mockGitHubInstallationApi();

    const plugin = githubPlugin({
      appPermissions: {
        contents: "write",
        issues: "write",
      },
    });
    const result = await plugin.hooks?.issueCredential?.({
      actor: { platform: "system", name: "scheduler" },
      grant: {
        name: "installation-read",
        access: "read",
        reason: "github.api-read",
      },
      db,
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

    const requests = mockGitHubInstallationApi();

    const plugin = githubPlugin();
    const ctx = {
      actor: { platform: "system" as const, name: "scheduler" },
      grant: {
        name: "installation-read",
        access: "read" as const,
        reason: "github.api-read",
      },
      db,
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

  it("requires user authorization context before issuing a user-write lease", async () => {
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const missingActor = await plugin.hooks?.issueCredential?.({
      actor: { platform: "system", name: "scheduler" },
      grant: { name: "user-write", access: "write" },
      db,
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

  it("issues a credential lease for a user-write grant from stored current-user tokens", async () => {
    mockGitHubUserApi();

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.user-write",
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
        account: {
          id: "12345",
          label: "actor",
          url: "https://github.com/actor",
        },
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
          {
            domain: "uploads.github.com",
            headers: { Authorization: "Bearer user-token" },
          },
        ],
      },
    });
  });

  it("resolves the GitHub account for user OAuth tokens", async () => {
    const requests = mockGitHubUserApi();

    const plugin = githubPlugin();
    const account = await plugin.hooks?.resolveOAuthAccount?.({
      db,
      log: pluginLog,
      plugin: { name: "github" },
      tokens: {
        accessToken: "user-token",
        refreshToken: "refresh-token",
      },
    });

    expect(account).toEqual({
      id: "12345",
      label: "actor",
      url: "https://github.com/actor",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.github.com/user",
      method: "GET",
    });
    expect(requests[0]?.headers.authorization).toBe("Bearer user-token");
  });

  it("surfaces operational failures while lazily resolving GitHub account identity", async () => {
    mockGitHubUserApi({
      status: 500,
      payload: { message: "server error" },
    });

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    await expect(
      plugin.hooks?.issueCredential?.(
        githubIssueCredentialContext({
          grant: {
            name: "user-write",
            access: "write",
            reason: "github.user-write",
          },
          currentUserToken: {
            accessToken: "user-token",
            expiresAt: Date.now() + 60 * 60_000,
            refreshToken: "refresh-token",
            scope: "repo",
          },
        }),
      ),
    ).rejects.toThrow("server error");
  });

  it("issues a credential lease for a user-write grant from delegated subject tokens", async () => {
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        actor: { platform: "system", name: "scheduler" },
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.user-write",
        },
        credentialSubjectToken: {
          account: {
            id: "45678",
            label: "delegated",
          },
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
          {
            domain: "uploads.github.com",
            headers: { Authorization: "Bearer delegated-token" },
          },
        ],
      },
    });
  });

  it("requires reauthorization when GitHub user token refresh is rejected", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    mockGitHubRefresh(400, { error: "bad_refresh_token" });

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.user-write",
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

  it("uses tokens refreshed by another request before refreshing a stale token", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";

    const staleToken = {
      accessToken: "stale-token",
      expiresAt: Date.now() + 60_000,
      refreshToken: "stale-refresh-token",
      scope: "repo",
    };
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.user-write",
        },
        currentUserToken: staleToken,
        currentUserTokenReads: [
          staleToken,
          {
            account: {
              id: "12345",
              label: "actor",
              url: "https://github.com/actor",
            },
            accessToken: "fresh-token",
            expiresAt: Date.now() + 60 * 60_000,
            refreshToken: "fresh-refresh-token",
            scope: "repo",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      type: "lease",
      lease: {
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer fresh-token" },
          },
          {
            domain: "github.com",
            headers: {
              Authorization: expect.stringMatching(/^Basic /),
            },
          },
          {
            domain: "uploads.github.com",
            headers: { Authorization: "Bearer fresh-token" },
          },
        ],
      },
    });
  });

  it("serializes concurrent refresh requests and reuses the rotated token", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const refreshTokenExpiresAt = now.getTime() + 30 * 24 * 60 * 60 * 1000;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(now);
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    const refreshRequests = mockGitHubRefresh(200, {
      access_token: "fresh-token",
      expires_in: 3600,
      refresh_token: "fresh-refresh-token",
    });
    const store = new TestTokenStore();
    const storedToken: PluginStoredTokens = {
      account: {
        id: "12345",
        label: "actor",
        url: "https://github.com/actor",
      },
      accessToken: "stale-token",
      expiresAt: Date.now() + 60_000,
      refreshToken: "stale-refresh-token",
      refreshTokenExpiresAt,
      scope: "repo",
    };
    await store.set("U123", "github", storedToken);
    const currentUser = {
      userId: "U123",
      get: vi.fn(async () => await store.get("U123", "github")),
      set: vi.fn(async (tokens) => {
        await store.set("U123", "github", tokens);
      }),
      withRefresh: async <T>(callback: () => Promise<T>) =>
        await store.withRefresh(callback),
    };
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const context = {
      actor: { type: "user" as const, userId: "U123" },
      grant: {
        name: "user-write",
        access: "write" as const,
        reason: "github.user-write",
      },
      db,
      log: pluginLog,
      plugin: { name: "github" },
      tokens: { currentUser },
    };

    const [first, second] = await Promise.all([
      plugin.hooks?.issueCredential?.(context),
      plugin.hooks?.issueCredential?.(context),
    ]);

    expect(refreshRequests).toHaveLength(1);
    for (const result of [first, second]) {
      expect(result).toMatchObject({
        type: "lease",
        lease: {
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: { Authorization: "Bearer fresh-token" },
            },
            {
              domain: "github.com",
              headers: {
                Authorization: expect.stringMatching(/^Basic /),
              },
            },
            {
              domain: "uploads.github.com",
              headers: { Authorization: "Bearer fresh-token" },
            },
          ],
        },
      });
    }
    await expect(store.get("U123", "github")).resolves.toMatchObject({
      refreshToken: "fresh-refresh-token",
      refreshTokenExpiresAt,
    });
  });

  it("uses the refreshed token expiry when GitHub returns one", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(now);
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    const oldRefreshTokenExpiresAt = now.getTime() + 30 * 24 * 60 * 60 * 1000;
    mockGitHubRefresh(200, {
      access_token: "fresh-token",
      expires_in: 3600,
      refresh_token: "fresh-refresh-token",
      refresh_token_expires_in: 7200,
    });

    const store = new TestTokenStore();
    const storedToken: PluginStoredTokens = {
      account: {
        id: "12345",
        label: "actor",
        url: "https://github.com/actor",
      },
      accessToken: "stale-token",
      expiresAt: Date.now() + 60_000,
      refreshToken: "stale-refresh-token",
      refreshTokenExpiresAt: oldRefreshTokenExpiresAt,
      scope: "repo",
    };
    await store.set("U123", "github", storedToken);
    const currentUser = {
      userId: "U123",
      get: vi.fn(async () => await store.get("U123", "github")),
      set: vi.fn(async (tokens) => {
        await store.set("U123", "github", tokens);
      }),
      withRefresh: async <T>(callback: () => Promise<T>) =>
        await store.withRefresh(callback),
    };
    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.({
      actor: { type: "user" as const, userId: "U123" },
      grant: {
        name: "user-write",
        access: "write",
        reason: "github.user-write",
      },
      db,
      log: pluginLog,
      plugin: { name: "github" },
      tokens: { currentUser },
    });

    expect(result?.type).toBe("lease");
    await expect(store.get("U123", "github")).resolves.toMatchObject({
      refreshToken: "fresh-refresh-token",
      refreshTokenExpiresAt: now.getTime() + 7200_000,
    });
  });

  it.each(["bad_refresh_token", "invalid_grant"])(
    "requires reauthorization when GitHub returns %s in a successful refresh response",
    async (errorCode) => {
      process.env.GITHUB_APP_CLIENT_ID = "client-id";
      process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
      mockGitHubRefresh(200, { error: errorCode });

      const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
      const result = await plugin.hooks?.issueCredential?.(
        githubIssueCredentialContext({
          grant: {
            name: "user-write",
            access: "write",
            reason: "github.user-write",
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
    },
  );

  it("requires reauthorization when GitHub returns a malformed successful refresh response", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    mockGitHubRefresh(200, { error_description: "refresh token expired" });

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    const result = await plugin.hooks?.issueCredential?.(
      githubIssueCredentialContext({
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.user-write",
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
    mockGitHubRefresh(500, { error: "server_error" });

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    await expect(
      plugin.hooks?.issueCredential?.(
        githubIssueCredentialContext({
          grant: {
            name: "user-write",
            access: "write",
            reason: "github.user-write",
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

  it("surfaces successful GitHub refresh responses with operational OAuth errors", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    mockGitHubRefresh(200, { error: "server_error" });

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    await expect(
      plugin.hooks?.issueCredential?.(
        githubIssueCredentialContext({
          grant: {
            name: "user-write",
            access: "write",
            reason: "github.user-write",
          },
          currentUserToken: {
            accessToken: "stale-token",
            expiresAt: Date.now() + 60_000,
            refreshToken: "stale-refresh-token",
            scope: "repo",
          },
        }),
      ),
    ).rejects.toThrow("GitHub user token refresh failed: 200 server_error");
  });

  it("surfaces malformed successful GitHub refresh token responses after access token parsing", async () => {
    process.env.GITHUB_APP_CLIENT_ID = "client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
    mockGitHubRefresh(200, { access_token: "new-access-token" });

    const plugin = githubPlugin({ additionalUserScopes: ["repo"] });
    await expect(
      plugin.hooks?.issueCredential?.(
        githubIssueCredentialContext({
          grant: {
            name: "user-write",
            access: "write",
            reason: "github.user-write",
          },
          currentUserToken: {
            accessToken: "stale-token",
            expiresAt: Date.now() + 60_000,
            refreshToken: "stale-refresh-token",
            scope: "repo",
          },
        }),
      ),
    ).rejects.toThrow("OAuth token response missing refresh_token");
  });

  it("prepares git attribution hooks and sandbox git config", async () => {
    const started: string[] = [];
    const writes: Array<{ content: string | Uint8Array; path: string }> = [];

    const plugin = githubPlugin();
    const ctx: SandboxPrepareHookContext = {
      db,
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
      "JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS",
    );
    expect(String(writes[0]?.content)).not.toContain("JUNIOR_GIT_COAUTHOR");
    expect(String(writes[0]?.content)).toContain(
      "Git author was not set to the Junior identity",
    );
    expect(started).toEqual([
      "core.hooksPath",
      "commit.gpgsign",
      "credential.helper",
      "http.emptyAuth",
    ]);
  });

  it("injects Junior author and committer identity", () => {
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
      GIT_COMMITTER_NAME: "sentry-junior[bot]",
      GIT_COMMITTER_EMAIL: "bot@example.com",
      JUNIOR_GIT_AUTHOR_NAME: "sentry-junior[bot]",
      JUNIOR_GIT_AUTHOR_EMAIL: "bot@example.com",
    });
    expect(before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS).toBe(
      "Co-Authored-By: David Cramer <david@example.com>",
    );
  });

  it("records Junior as Git author and committer with human attribution", async () => {
    const {
      copyFileSync,
      mkdirSync,
      mkdtempSync,
      readFileSync,
      rmSync,
      writeFileSync,
    } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");

    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const before = beforeToolContext({
      email: "david@example.com",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "dcramer",
    });
    githubPlugin().hooks?.beforeToolExecute?.(before.ctx as never);

    const hook = await prepareCommitMsgHookFixture("unused\n");
    const repoDir = mkdtempSync(join(tmpdir(), "junior-github-commit-"));
    mkdirSync(join(repoDir, ".git", "hooks"), { recursive: true });

    const runGit = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: repoDir,
        env: { ...process.env, ...before.env },
      });

    try {
      expect(runGit("init").status).toBe(0);
      copyFileSync(
        hook.hookPath,
        join(repoDir, ".git", "hooks", "prepare-commit-msg"),
      );
      writeFileSync(join(repoDir, "README.md"), "test\n");
      expect(runGit("add", "README.md").status).toBe(0);

      const commit = runGit(
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "test commit",
      );
      expect(commit.stderr.toString()).toBe("");
      expect(commit.status).toBe(0);

      const metadata = runGit("log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%B");
      expect(metadata.status).toBe(0);
      expect(metadata.stdout.toString()).toBe(
        "sentry-junior[bot]\n" +
          "bot@example.com\n" +
          "sentry-junior[bot]\n" +
          "bot@example.com\n" +
          "test commit\n" +
          "\n" +
          "Co-Authored-By: David Cramer <david@example.com>\n" +
          "\n",
      );
      expect(readFileSync(join(repoDir, "README.md"), "utf8")).toBe("test\n");
    } finally {
      rmSync(hook.dir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("credits the primary and additional run actors as co-author trailers", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const runActor: TestActor = {
      email: "dave@example.com",
      fullName: "David Cramer",
      platform: "slack",
      teamId: "T1",
      userId: "U1",
    };
    const before = beforeToolContext(runActor, [
      // Same identity as the primary actor under a different display profile;
      // it must still be included only once because distinctness uses ids.
      { ...runActor, fullName: "Dave" },
      {
        email: "bob@example.com",
        fullName: "Bob Steer",
        platform: "slack",
        teamId: "T1",
        userId: "U2",
      },
      {
        email: "carol@example.com",
        fullName: "Carol Steer",
        platform: "slack",
        teamId: "T1",
        userId: "U3",
      },
    ]);
    before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS =
      "Co-Authored-By: Model Supplied <model@example.com>";

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toBeUndefined();
    expect(before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS).toBe(
      "Co-Authored-By: David Cramer <dave@example.com>\nCo-Authored-By: Bob Steer <bob@example.com>\nCo-Authored-By: Carol Steer <carol@example.com>",
    );
  });

  it("omits a steering actor without a resolvable name or email, without denying the commit", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const runActor: TestActor = {
      email: "dave@example.com",
      fullName: "David Cramer",
      platform: "slack",
      teamId: "T1",
      userId: "U1",
    };
    const before = beforeToolContext(runActor, [
      runActor,
      {
        // No email: unresolvable for trailer purposes, must be omitted.
        fullName: "Bob Steer",
        platform: "slack",
        teamId: "T1",
        userId: "U2",
      },
      {
        // No display name: unresolvable for trailer purposes, must be omitted.
        email: "carol@example.com",
        platform: "slack",
        teamId: "T1",
        userId: "U3",
      },
    ]);

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toBeUndefined();
    expect(before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS).toBe(
      "Co-Authored-By: David Cramer <dave@example.com>",
    );
  });

  it("uses a later resolvable profile for a duplicate actor identity", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const runActor: TestActor = {
      platform: "slack",
      teamId: "T1",
      userId: "U1",
    };
    const before = beforeToolContext(runActor, [
      runActor,
      {
        email: "dave@example.com",
        fullName: "David Cramer",
        platform: "slack",
        teamId: "T1",
        userId: "U1",
      },
    ]);

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS).toBe(
      "Co-Authored-By: David Cramer <dave@example.com>",
    );
  });

  it("dedups additional actors by resolved email and drops one matching the bot email", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const runActor: TestActor = {
      email: "dave@example.com",
      fullName: "David Cramer",
      platform: "slack",
      teamId: "T1",
      userId: "U1",
    };
    const before = beforeToolContext(runActor, [
      runActor,
      {
        email: "bob@example.com",
        fullName: "Bob Steer",
        platform: "slack",
        teamId: "T1",
        userId: "U2",
      },
      {
        // Distinct identity, same email as U2 case-insensitively: dedups to one trailer.
        email: "BOB@example.com",
        fullName: "Bob Steer (alt profile)",
        platform: "slack",
        teamId: "T1",
        userId: "U4",
      },
      {
        // Resolves to the bot's own email: must never surface as an actor trailer.
        email: "bot@example.com",
        fullName: "Bot Impersonator",
        platform: "slack",
        teamId: "T1",
        userId: "U5",
      },
    ]);

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toBeUndefined();
    expect(before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS).toBe(
      "Co-Authored-By: David Cramer <dave@example.com>\nCo-Authored-By: Bob Steer <bob@example.com>",
    );
  });

  it("credits the primary actor in a single-actor run", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const runActor: TestActor = {
      email: "dave@example.com",
      fullName: "David Cramer",
      platform: "slack",
      teamId: "T1",
      userId: "U1",
    };
    const before = beforeToolContext(runActor, [runActor]);
    before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS =
      "Co-Authored-By: Model Supplied <model@example.com>";

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toBeUndefined();
    expect(before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS).toBe(
      "Co-Authored-By: David Cramer <dave@example.com>",
    );
  });

  it.each([
    [
      "appends human actor trailers as one contiguous block and stays idempotent on rerun",
      "initial commit message\n",
      "initial commit message\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Co-Authored-By: Carol Steer <carol@example.com>\n",
    ],
    [
      "ignores matching trailer lines outside the final trailer block",
      "initial commit message\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "body details continue here\n",
      "initial commit message\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "body details continue here\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Co-Authored-By: Carol Steer <carol@example.com>\n",
    ],
    [
      "extends an existing trailer block in place when some trailers are already present",
      "initial commit message\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n",
      "initial commit message\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Co-Authored-By: Carol Steer <carol@example.com>\n",
    ],
    [
      "deduplicates desired trailers already repeated in the final block",
      "initial commit message\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Co-Authored-By: Carol Steer <carol@example.com>\n",
      "initial commit message\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Co-Authored-By: Carol Steer <carol@example.com>\n",
    ],
    [
      "extends a final trailer block ending with another trailer",
      "initial commit message\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Signed-off-by: Reviewer <reviewer@example.com>\n",
      "initial commit message\n" +
        "\n" +
        "Co-Authored-By: Bob Steer <bob@example.com>\n" +
        "Signed-off-by: Reviewer <reviewer@example.com>\n" +
        "Co-Authored-By: Carol Steer <carol@example.com>\n",
    ],
  ])("%s", async (_name, initialMessage, expectedMessage) => {
    const { readFileSync, rmSync } = await import("node:fs");
    const { dir, messagePath, runHook } =
      await prepareCommitMsgHookFixture(initialMessage);

    const firstRun = runHook();
    expect(firstRun.stderr.toString()).toBe("");
    expect(firstRun.status).toBe(0);
    expect(readFileSync(messagePath, "utf8")).toBe(expectedMessage);
    expect(runHook().status).toBe(0);
    expect(readFileSync(messagePath, "utf8")).toBe(expectedMessage);

    rmSync(dir, { recursive: true, force: true });
  });

  it("uses Junior author identity when the human actor is unresolved", () => {
    process.env.GITHUB_APP_BOT_NAME = "sentry-junior[bot]";
    process.env.GITHUB_APP_BOT_EMAIL = "bot@example.com";

    const plugin = githubPlugin();
    const before = beforeToolContext({
      fullName: "U039RR91S",
      userId: "U039RR91S",
      userName: "U039RR91S",
    });

    plugin.hooks?.beforeToolExecute?.(before.ctx as never);

    expect(before.denial).toBeUndefined();
    expect(before.env).toMatchObject({
      GIT_COMMITTER_NAME: "sentry-junior[bot]",
      GIT_COMMITTER_EMAIL: "bot@example.com",
      GIT_AUTHOR_NAME: "sentry-junior[bot]",
      GIT_AUTHOR_EMAIL: "bot@example.com",
      JUNIOR_GIT_AUTHOR_NAME: "sentry-junior[bot]",
      JUNIOR_GIT_AUTHOR_EMAIL: "bot@example.com",
    });
    expect(before.env.JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS).toBe("");
  });
});
