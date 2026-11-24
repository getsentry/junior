import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb } from "@/chat/db";
import {
  createConversationWorkQueueTestAdapter,
  runTestHeartbeat,
} from "../../fixtures/conversation-work";
import {
  createGitHubApp,
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  sendGitHubWebhook,
  stubGitHubApp,
  viewerApi,
} from "../../fixtures/github-objects";
import { mswServer } from "../../msw/server";

const DASHBOARD = "https://junior.example.com";
const BOT_EMAIL = "41898282+junior-test[bot]@users.noreply.github.com";
const T0 = "2026-01-02T03:00:00Z";
const T1 = "2026-01-02T04:00:00Z";

function pullRequest(number: number, overrides: Record<string, unknown> = {}) {
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

/** A `nodes` result with the check run counts of the head commit. */
function checkRuns(counts: Record<string, number>) {
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

interface GraphqlQuery {
  ids: string[];
  operationName: string;
}

/** Answer each GraphQL query with the next nodes, and keep the queries. */
function stubGraphql(answers: unknown[][]): GraphqlQuery[] {
  const queries: GraphqlQuery[] = [];
  mswServer.use(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const body = (await request.json()) as {
        operationName: string;
        variables: { ids: string[] };
      };
      queries.push({
        ids: body.variables.ids,
        operationName: body.operationName,
      });
      return HttpResponse.json({ data: { nodes: answers.shift() ?? [] } });
    }),
  );
  return queries;
}

describe("GitHub pull request cache refresh", () => {
  let previousDashboard: ReturnType<typeof setDashboardConversationLinkOptions>;

  beforeEach(() => {
    previousDashboard = setDashboardConversationLinkOptions({
      baseURL: DASHBOARD,
    });
  });

  afterEach(async () => {
    setDashboardConversationLinkOptions(previousDashboard);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("shows merge state and checks as pending after a push, then one patch query fills them", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () => {
        reads.push("pulls/34");
        return HttpResponse.json(pullRequest(34));
      }),
    );
    const queries = stubGraphql([
      [
        {
          commits: checkRuns({ FAILURE: 1, IN_PROGRESS: 2, SUCCESS: 3 }),
          headRefOid: "ccc333",
          id: "PR_34",
          mergeable: "CONFLICTING",
          updatedAt: "2026-01-02T03:00:12Z",
        },
      ],
      [
        {
          commits: checkRuns({ FAILURE: 1, SUCCESS: 5 }),
          headRefOid: "ccc333",
          id: "PR_34",
          mergeable: "CONFLICTING",
          updatedAt: "2026-01-02T03:00:12Z",
        },
      ],
    ]);
    const app = await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    const queue = createConversationWorkQueueTestAdapter();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });

    // Two pushes inside the patch delay. GitHub computes mergeability later.
    for (const [offset, sha] of [
      [10, "bbb222"],
      [12, "ccc333"],
    ] as const) {
      vi.setSystemTime(start + offset * 1000);
      await sendGitHubWebhook(app, "pull_request", {
        action: "synchronize",
        pull_request: pullRequest(34, {
          additions: 130,
          head: { ref: "feat/object-cache", sha },
          mergeable: null,
          updated_at: new Date(start + offset * 1000).toISOString(),
        }),
      });
    }
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      additions: 130,
      checks: "pending",
      mergeable: "pending",
    });

    vi.setSystemTime(start + 60_000);
    await runTestHeartbeat(queue, Date.now());
    // One query reads only the merge state and checks, not the whole entry.
    expect(queries).toEqual([
      { ids: ["PR_34"], operationName: "PullRequestHeadFacts" },
    ]);
    expect(reads).toEqual(["pulls/34"]);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      additions: 130,
      checks: { failed: 1, passed: 3, pending: 2 },
      mergeable: false,
    });

    // A finished check suite carries no counts, so a patch counts them.
    await sendGitHubWebhook(app, "check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "success",
        head_branch: "feat/object-cache",
        head_sha: "ccc333",
        id: 7001,
        pull_requests: [{ number: 34 }],
        status: "completed",
      },
    });
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: "pending",
      mergeable: false,
    });
    vi.setSystemTime(start + 120_000);
    await runTestHeartbeat(queue, Date.now());
    expect(queries).toHaveLength(2);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 1, passed: 5, pending: 0 },
      mergeable: false,
    });
    expect(reads).toEqual(["pulls/34"]);
  });

  it("reads a page of stale pull request cards in one query, and adds an older pull request after one read", async () => {
    stubGitHubApp();
    vi.stubEnv("GITHUB_APP_BOT_EMAIL", BOT_EMAIL);
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/:number`, ({ params }) => {
        const number = Number(params["number"]);
        reads.push(`pulls/${number}`);
        return number === 36
          ? HttpResponse.json(pullRequest(36, { updated_at: T1 }))
          : HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    const node = (number: number) => ({
      additions: number,
      author: { login: "junior-test[bot]" },
      baseRefName: "main",
      body: "Cache GitHub objects.",
      changedFiles: 2,
      commits: checkRuns({ SUCCESS: 2 }),
      deletions: 1,
      headRefName: `feat/${number}`,
      headRefOid: "ddd444",
      id: `PR_${number}`,
      isDraft: number === 35,
      mergeable: "MERGEABLE",
      merged: false,
      number,
      reviewRequests: { nodes: [] },
      state: "OPEN",
      title: `Renamed ${number}`,
      updatedAt: "2026-01-02T06:00:00Z",
      url: `${GITHUB_REPO}/pull/${number}`,
    });
    const queries = stubGraphql([[34, 35].map(node), [34, 35, 36].map(node)]);
    const app = await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const urls = [34, 35, 36].map((number) => `${GITHUB_REPO}/pull/${number}`);
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    // Junior's own pull requests: the webhook stores their GraphQL ids. The
    // row of #36 is from before Junior stored them.
    for (const number of [34, 35, 36]) {
      await sendGitHubWebhook(app, "pull_request", {
        action: "opened",
        pull_request: pullRequest(number, {
          body: "Cache GitHub objects.\n\n<!-- junior-session-footer:start -->\nJunior\n<!-- junior-session-footer:end -->",
          node_id: number === 36 ? undefined : `PR_${number}`,
          user: { login: "junior-test[bot]" },
        }),
      });
    }

    // Webhooks keep pull request entries fresh for an hour.
    vi.setSystemTime(start + 30 * 60_000);
    await read(...urls);
    expect([reads, queries]).toEqual([[], []]);

    vi.setSystemTime(start + 61 * 60_000);
    const cards = (await read(...urls)).objects;
    expect(queries).toEqual([
      { ids: ["PR_34", "PR_35"], operationName: "PullRequestCards" },
    ]);
    // Only the pull request with no stored id reads on its own.
    expect(reads).toEqual(["pulls/36"]);
    expect(cards.get(urls[0]!)).toMatchObject({
      facts: { additions: 34, checks: { failed: 0, passed: 2, pending: 0 } },
      status: "open",
      title: "Renamed 34",
    });
    expect(cards.get(urls[1]!)).toMatchObject({
      status: "draft",
      title: "Renamed 35",
    });

    // That read stored its id, so the next page reads all three at once.
    vi.setSystemTime(start + 122 * 60_000);
    expect((await read(...urls)).objects.get(urls[2]!)).toMatchObject({
      title: "Renamed 36",
    });
    expect(queries.at(-1)).toEqual({
      ids: ["PR_34", "PR_35", "PR_36"],
      operationName: "PullRequestCards",
    });
    expect(reads).toEqual(["pulls/36"]);
  });

  it("shows an unknown merge state from a page read as pending, then a patch reads it", async () => {
    stubGitHubApp();
    vi.stubEnv("GITHUB_APP_BOT_EMAIL", BOT_EMAIL);
    const queries = stubGraphql([
      [
        {
          additions: 34,
          author: { login: "junior-test[bot]" },
          baseRefName: "main",
          body: "Cache GitHub objects.",
          changedFiles: 2,
          commits: checkRuns({ SUCCESS: 2 }),
          deletions: 1,
          headRefName: "feat/object-cache",
          headRefOid: "ddd444",
          id: "PR_34",
          isDraft: false,
          // GitHub still computes it.
          mergeable: "UNKNOWN",
          merged: false,
          number: 34,
          reviewRequests: { nodes: [] },
          state: "OPEN",
          title: "Cache GitHub objects",
          updatedAt: "2026-01-02T03:30:00Z",
          url: `${GITHUB_REPO}/pull/34`,
        },
      ],
      [
        {
          commits: checkRuns({ SUCCESS: 2 }),
          headRefOid: "ddd444",
          id: "PR_34",
          mergeable: "MERGEABLE",
          updatedAt: "2026-01-02T03:30:00Z",
        },
      ],
    ]);
    const app = await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    const queue = createConversationWorkQueueTestAdapter();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    // Junior's own pull request: the webhook stores its GraphQL id.
    await sendGitHubWebhook(app, "pull_request", {
      action: "opened",
      pull_request: pullRequest(34, {
        body: "Cache GitHub objects.\n\n<!-- junior-session-footer:start -->\nJunior\n<!-- junior-session-footer:end -->",
        user: { login: "junior-test[bot]" },
      }),
    });

    vi.setSystemTime(start + 61 * 60_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });
    vi.setSystemTime(start + 62 * 60_000);
    await runTestHeartbeat(queue, Date.now());
    expect(queries.map((query) => query.operationName)).toEqual([
      "PullRequestCards",
      "PullRequestHeadFacts",
    ]);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
  });

  it("gives a push during merge state retries a full set of attempts", async () => {
    stubGitHubApp();
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () =>
        HttpResponse.json(pullRequest(34)),
      ),
    );
    const headFacts = (sha: string, mergeable: string, updatedAt: string) => [
      {
        commits: checkRuns({ SUCCESS: 1 }),
        headRefOid: sha,
        id: "PR_34",
        mergeable,
        updatedAt,
      },
    ];
    // GitHub computes the merge state of the first push for four reads,
    // then of the second push for one more.
    const queries = stubGraphql([
      ...Array.from({ length: 4 }, () =>
        headFacts("bbb222", "UNKNOWN", "2026-01-02T03:00:10Z"),
      ),
      headFacts("ccc333", "UNKNOWN", "2026-01-02T03:04:30Z"),
      headFacts("ccc333", "MERGEABLE", "2026-01-02T03:04:30Z"),
    ]);
    const app = await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    const queue = createConversationWorkQueueTestAdapter();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    await read(url);
    const push = async (sha: string, atMs: number) => {
      vi.setSystemTime(atMs);
      await sendGitHubWebhook(app, "pull_request", {
        action: "synchronize",
        pull_request: pullRequest(34, {
          head: { ref: "feat/object-cache", sha },
          mergeable: null,
          updated_at: new Date(atMs).toISOString(),
        }),
      });
    };
    await push("bbb222", start + 10_000);
    for (let minute = 1; minute <= 4; minute++) {
      vi.setSystemTime(start + minute * 60_000);
      await runTestHeartbeat(queue, Date.now());
    }
    await push("ccc333", start + 4 * 60_000 + 30_000);
    vi.setSystemTime(start + 5 * 60_000);
    await runTestHeartbeat(queue, Date.now());
    // The new head commit is still computing, so it is still pending.
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });
    vi.setSystemTime(start + 6 * 60_000);
    await runTestHeartbeat(queue, Date.now());
    expect(queries).toHaveLength(6);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
  });
});
