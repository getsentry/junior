/**
 * Object link API helpers: a signed-in viewer's card reads, and a GitHub App
 * with webhooks for `getsentry/junior`.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { expect, vi } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createJuniorApi } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { getSqlExecutor } from "@/chat/db";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { linkSlackUser } from "./slack-user";
import { signedInViewer } from "./user";
import { mswServer } from "../msw/server";

/**
 * Read `/api/objects` as one signed-in viewer. Returns the cards by URL.
 */
export async function viewerApi(email: string) {
  const viewer = await signedInViewer(email);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return async (...urls: string[]) => {
    const query = new URLSearchParams(urls.map((url) => ["url", url]));
    const response = await app.request(`http://localhost/api/objects?${query}`);
    expect(response.status).toBe(200);
    // The browser may keep a card as long as the server cache does.
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(response.headers.get("vary")).toBe("Authorization, Cookie");
    const body = await response.text();
    return {
      body,
      objects: new Map(
        objectLinksReportSchema
          .parse(JSON.parse(body))
          .objects.map((item) => [item.url, item.object]),
      ),
    };
  };
}

export const GITHUB_REPO = "https://github.com/getsentry/junior";
export const GITHUB_API = "https://api.github.com/repos/getsentry/junior";

/**
 * Configure the GitHub App. Only the GitHub account `alice_acme` can see
 * `getsentry/junior`.
 */
export function stubGitHubApp() {
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
  vi.stubEnv(
    "GITHUB_APP_PRIVATE_KEY",
    generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs1" })
      .toString(),
  );
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  mswServer.use(
    http.get("https://api.github.com/app/installations/456", () =>
      HttpResponse.json({
        permissions: {
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
      }),
    ),
    http.post(
      "https://api.github.com/app/installations/456/access_tokens",
      () =>
        HttpResponse.json({
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          token: "app-token",
        }),
    ),
    http.get(`${GITHUB_API}/collaborators/:login/permission`, ({ params }) =>
      HttpResponse.json({
        permission: params["login"] === "alice_acme" ? "read" : "none",
      }),
    ),
  );
}

/** Link alice@example.com to the GitHub account that sees the repository. */
export async function linkGitHubMember() {
  const alice = await linkSlackUser("alice@example.com", "UALICE");
  await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
    handle: "alice_acme",
    kind: "user",
    provider: "github",
    providerSubjectId: "1001",
  });
}

/** Send a signed GitHub webhook through the app route. */
export async function sendGitHubWebhook(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  event: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify({
    installation: { id: 456 },
    repository: { full_name: "getsentry/junior", id: 2001 },
    sender: { login: "byk" },
    ...payload,
  });
  const response = await app.fetch(
    new Request("https://example.test/api/webhooks/github", {
      body,
      headers: {
        "x-github-delivery": `delivery-${event}-${Date.now()}`,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
          .update(body)
          .digest("hex")}`,
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(202);
}

/** Create the app with the GitHub plugin and its tables. */
export async function createGitHubApp(
  options: Pick<
    NonNullable<Parameters<typeof createApp>[0]>,
    "pluginTaskQueue"
  > = {},
) {
  const { app } = await createApp({
    ...options,
    plugins: defineJuniorPlugins([githubPlugin()]),
  });
  // Webhooks record lifecycles in the plugin's tables.
  await migratePluginSchemas(getSqlExecutor(), [
    {
      dir: path.resolve(process.cwd(), "../junior-github/migrations"),
      pluginName: "github",
    },
  ]);
  return app;
}

/** `updated_at` of the pull request payloads below. */
export const T0 = "2026-01-02T03:00:00Z";

/** A `pull_request` webhook payload for one open pull request. */
export function pullRequest(
  number: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    additions: 120,
    base: { ref: "main" },
    body: "Cache GitHub objects.",
    changed_files: 4,
    closed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    deletions: 8,
    draft: false,
    head: { ref: "feat/object-cache", sha: "aaa111" },
    html_url: `${GITHUB_REPO}/pull/${number}`,
    id: number * 1000,
    mergeable: true,
    merged: false,
    merged_at: null,
    node_id: `PR_${number}`,
    number,
    state: "open",
    title: "Cache GitHub objects",
    updated_at: T0,
    user: { login: "byk" },
    ...overrides,
  };
}

/** A `commits` result with the check run counts of the head commit. */
export function checkRuns(counts: Record<string, number>) {
  return {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              checkRunCountsByState: Object.entries(counts).map(
                ([state, count]) => ({ count, state }),
              ),
            },
          },
        },
      },
    ],
  };
}

/** Card and patch queries name pull requests by repository and number. */
export interface GraphqlQuery {
  numbers: number[];
  operationName: string;
}

/**
 * Answer GraphQL queries and keep them. Each alias of a query gets the pull
 * request of its number that the answer has. A card query answers from
 * `cards`, or with the HTTP status that `cards` returns for the numbers
 * that it asks for. A patch query answers from the next list of `patches`.
 */
export function stubGraphql(answers: {
  cards?: unknown[] | ((numbers: number[]) => unknown[] | number);
  patches?: unknown[][];
}): GraphqlQuery[] {
  const queries: GraphqlQuery[] = [];
  mswServer.use(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const { operationName, variables } = (await request.json()) as {
        operationName: string;
        variables: Record<string, unknown>;
      };
      const numbers = Object.entries(variables).flatMap(([name, value]) =>
        name.startsWith("number") ? [Number(value)] : [],
      );
      queries.push({ numbers, operationName });
      // A patch read also names each pull request by GitHub's id, as the
      // `pullRequest` payloads do, and has its review requests.
      const cards =
        operationName === "PullRequestHeadFacts"
          ? (answers.patches?.shift() ?? []).map((node) => ({
              databaseId: (node as { number: number }).number * 1000,
              reviewRequests: { nodes: [] },
              ...(node as object),
            }))
          : typeof answers.cards === "function"
            ? answers.cards(numbers)
            : (answers.cards ?? []);
      if (typeof cards === "number") {
        return HttpResponse.json(
          { message: "Server Error" },
          { status: cards },
        );
      }
      const byNumber = new Map(
        cards.map((node) => [(node as { number: number }).number, node]),
      );
      return HttpResponse.json({
        data: Object.fromEntries(
          numbers.map((number, index) => [
            `p${index}`,
            byNumber.has(number) ? { pullRequest: byNumber.get(number) } : null,
          ]),
        ),
      });
    }),
  );
  return queries;
}

/**
 * The merge state and check patch queries. A page read also asks for the
 * card of an entry with no review decision, such as a REST read.
 */
export function patchQueries(queries: GraphqlQuery[]): GraphqlQuery[] {
  return queries.filter(
    (query) => query.operationName === "PullRequestHeadFacts",
  );
}

/** A card query result for one open pull request. */
export function cardNode(number: number) {
  return {
    additions: number,
    assignees: { nodes: [] },
    author: { login: "junior-test[bot]" },
    baseRefName: "main",
    body: "Cache GitHub objects.",
    changedFiles: 2,
    commits: checkRuns({ SUCCESS: 2 }),
    deletions: 1,
    headRefName: `feat/${number}`,
    headRefOid: "ddd444",
    isDraft: number === 35,
    mergeable: "MERGEABLE",
    merged: false,
    number,
    reviewRequests: { nodes: [] },
    state: "OPEN",
    title: `Renamed ${number}`,
    updatedAt: "2026-01-02T06:00:00Z",
    url: `${GITHUB_REPO}/pull/${number}`,
  };
}
