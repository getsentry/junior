import { generateKeyPairSync } from "node:crypto";
import type {
  PluginCache,
  PluginGitPush,
  PluginGitRefUpdate,
} from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubPlugin } from "../src/index";
import { mswServer } from "./msw";

const PUSH_URL = "https://github.com/getsentry/junior.git/git-receive-pack";
const ORIGINAL_ENV = process.env;

function update(ref: string, deletes = false): PluginGitRefUpdate {
  return { deletes, ref };
}

function commands(...updates: PluginGitRefUpdate[]): PluginGitPush {
  return { kind: "commands", updates };
}

function memoryCache(): PluginCache {
  const values = new Map<string, unknown>();
  return {
    async getOrLoad<T>(
      key: string,
      load: () => Promise<{ ttlMs?: number; value: T }>,
    ) {
      if (values.has(key)) return values.get(key) as T;
      const entry = await load();
      if (entry.ttlMs) values.set(key, entry.value);
      return entry.value;
    },
  };
}

function mockRepository(input?: { status?: number }) {
  const lookups: string[] = [];
  mswServer.use(
    http.post(
      "https://api.github.com/app/installations/:installationId/access_tokens",
      () =>
        HttpResponse.json({
          token: "metadata-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
    ),
    http.get("https://api.github.com/repos/:owner/:name", ({ request }) => {
      lookups.push(request.url);
      return input?.status
        ? HttpResponse.json({ message: "Not Found" }, { status: input.status })
        : HttpResponse.json({ default_branch: "main" });
    }),
  );
  return lookups;
}

async function grantForPush(
  gitPush: PluginGitPush | undefined,
  cache = memoryCache(),
) {
  return await githubPlugin().hooks?.grantForEgress?.({
    cache,
    db: undefined,
    log: { error() {}, info() {}, warn() {} },
    plugin: { name: "github" },
    request: {
      ...(gitPush ? { gitPush } : undefined),
      method: "POST",
      url: PUSH_URL,
    },
  });
}

async function denial(gitPush: PluginGitPush | undefined) {
  return await grantForPush(gitPush).then(
    () => {
      throw new Error("Expected the push to be denied");
    },
    (error: unknown) => error as Error & { auditAttributes?: unknown },
  );
}

describe("GitHub Git push policy", () => {
  beforeAll(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_INSTALLATION_ID"] = "456";
    process.env["GITHUB_APP_PRIVATE_KEY"] = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("allows a branch push and records its refs", async () => {
    mockRepository();
    const grant = await grantForPush(commands(update("refs/heads/feat/x")));

    expect(grant).toMatchObject({
      name: "installation-write",
      auditAttributes: {
        "app.github.default_branch": "main",
        "app.github.default_branch_targeted": false,
        "app.github.refs": ["refs/heads/feat/x"],
        "app.github.repository": "getsentry/junior",
      },
    });
  });

  it("allows a branch delete with no pack", async () => {
    mockRepository();
    const grant = await grantForPush(
      commands(update("refs/heads/feat/x", true)),
    );

    expect(grant?.auditAttributes?.["app.github.refs"]).toEqual([
      "refs/heads/feat/x",
    ]);
  });

  it("allows the auth probe that Git sends before a large push", async () => {
    const lookups = mockRepository();
    const grant = await grantForPush(commands());

    expect(grant?.auditAttributes?.["app.github.refs"]).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it("refuses a multi-ref atomic push that includes the default branch", async () => {
    mockRepository();
    const error = await denial(
      commands(update("refs/heads/feat/x"), update("refs/heads/main")),
    );

    expect(error.name).toBe("EgressPolicyDenied");
    expect(error.message).toContain(
      "The runtime never pushes to the default branch (main) of getsentry/junior.",
    );
    expect(error.message).toContain("github_createPullRequest");
    expect(error.auditAttributes).toEqual({
      "app.github.default_branch": "main",
      "app.github.default_branch_targeted": true,
      "app.github.refs": ["refs/heads/feat/x", "refs/heads/main"],
    });
  });

  it("refuses to delete the default branch", async () => {
    mockRepository();
    const error = await denial(commands(update("refs/heads/main", true)));

    expect(error.message).toContain(
      "The runtime never deletes the default branch",
    );
  });

  it.each<[string, PluginGitPush | undefined, string]>([
    [
      "a tag",
      commands(update("refs/tags/v1.0.0")),
      "The runtime pushes only branches. It refused refs/tags/v1.0.0.",
    ],
    [
      "a signed push",
      { kind: "unreadable", reason: "signed" },
      "The runtime does not accept signed Git pushes.",
    ],
    [
      "a gzip body",
      { kind: "unreadable", reason: "gzip" },
      "The runtime cannot read a gzip-compressed Git push.",
    ],
    [
      "a command list with no flush",
      { kind: "unreadable", reason: "unterminated" },
      "The runtime could not find the end of the Git push command list.",
    ],
    [
      "a malformed command",
      { kind: "unreadable", reason: "malformed" },
      "The runtime could not read the Git push command list.",
    ],
    [
      "a push the host did not read",
      undefined,
      "The runtime could not read the Git push command list.",
    ],
  ])("refuses %s", async (_label, gitPush, message) => {
    const lookups = mockRepository();
    const error = await denial(gitPush);

    expect(error.message).toContain(message);
    expect(lookups).toEqual([]);
  });

  it("refuses the push when the default branch lookup fails", async () => {
    mockRepository({ status: 404 });
    const error = await denial(commands(update("refs/heads/feat/x")));

    expect(error.message).toContain(
      "The runtime could not read the default branch of getsentry/junior",
    );
  });

  it("caches the default branch per repository", async () => {
    const lookups = mockRepository();
    const cache = memoryCache();
    const push = commands(update("refs/heads/feat/x"));
    await grantForPush(push, cache);
    await grantForPush(push, cache);

    expect(lookups).toEqual(["https://api.github.com/repos/getsentry/junior"]);
  });
});
