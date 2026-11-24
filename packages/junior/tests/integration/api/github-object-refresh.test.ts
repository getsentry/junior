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

/** A patch query names pull requests by id, a card query by number. */
interface GraphqlQuery {
  ids?: string[];
  numbers?: number[];
  operationName: string;
}

/**
 * Answer GraphQL queries and keep them. A card query gets each pull request
 * that it asks for and that `cards` has, or the HTTP status that `cards`
 * returns for the numbers that it asks for. A patch query gets the next
 * nodes of `patches`.
 */
function stubGraphql(answers: {
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
      const ids = variables["ids"];
      if (Array.isArray(ids)) {
        queries.push({ ids: ids.map(String), operationName });
        return HttpResponse.json({
          data: { nodes: answers.patches?.shift() ?? [] },
        });
      }
      const numbers = Object.entries(variables).flatMap(([name, value]) =>
        name.startsWith("number") ? [Number(value)] : [],
      );
      queries.push({ numbers, operationName });
      const cards =
        typeof answers.cards === "function"
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

/** A card query result for one open pull request. */
function cardNode(number: number) {
  return {
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
  };
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
    const queries = stubGraphql({
      patches: [
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
      ],
    });
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
    // The page query has no card for #34, so it read on its own. Then one
    // query reads only the merge state and checks, not the whole entry.
    expect(queries).toEqual([
      { numbers: [34], operationName: "PullRequestCards" },
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
    expect(queries).toHaveLength(3);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 1, passed: 5, pending: 0 },
      mergeable: false,
    });
    expect(reads).toEqual(["pulls/34"]);
  });

  it("reads a page of stale pull request cards in one query", async () => {
    stubGitHubApp();
    vi.stubEnv("GITHUB_APP_BOT_EMAIL", BOT_EMAIL);
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/:number`, ({ params }) => {
        reads.push(`pulls/${String(params["number"])}`);
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    const queries = stubGraphql({ cards: [34, 35, 36].map(cardNode) });
    const app = await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const urls = [34, 35, 36].map((number) => `${GITHUB_REPO}/pull/${number}`);
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    for (const number of [34, 35, 36]) {
      await sendGitHubWebhook(app, "pull_request", {
        action: "opened",
        pull_request: pullRequest(number, {
          body: "Cache GitHub objects.\n\n<!-- junior-session-footer:start -->\nJunior\n<!-- junior-session-footer:end -->",
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
      { numbers: [34, 35, 36], operationName: "PullRequestCards" },
    ]);
    expect(reads).toEqual([]);
    expect(cards.get(urls[0]!)).toMatchObject({
      facts: { additions: 34, checks: { failed: 0, passed: 2, pending: 0 } },
      status: "open",
      title: "Renamed 34",
    });
    expect(cards.get(urls[1]!)).toMatchObject({
      status: "draft",
      title: "Renamed 35",
    });
    expect(cards.get(urls[2]!)).toMatchObject({ title: "Renamed 36" });
  });

  it("splits a failed card query in halves, and each half reads its cards", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/:number`, ({ params }) => {
        reads.push(`pulls/${String(params["number"])}`);
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    const numbers = Array.from({ length: 27 }, (_, index) => 34 + index);
    const nodes = numbers.map(cardNode);
    // A query of more than 13 pull requests fails.
    const queries = stubGraphql({
      cards: (asked) => (asked.length > 13 ? 502 : nodes),
    });
    await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const urls = numbers.map((number) => `${GITHUB_REPO}/pull/${number}`);

    const cards = (await read(...urls)).objects;
    // A page reads at most 25 pull requests in one query. The failed query
    // splits in halves.
    const asked = queries.map((query) => query.numbers);
    expect(asked).toHaveLength(4);
    expect(asked).toEqual(
      expect.arrayContaining([
        numbers.slice(0, 25),
        numbers.slice(25),
        numbers.slice(0, 13),
        numbers.slice(13, 25),
      ]),
    );
    expect(reads).toEqual([]);
    expect(urls.map((url) => cards.get(url)?.title)).toEqual(
      numbers.map((number) => `Renamed ${number}`),
    );
  });

  it("stops reading cards when a page's time is used, and shows the stale ones", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/:number`, ({ params }) => {
        reads.push(`pulls/${String(params["number"])}`);
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    let reachGitHub!: () => void;
    const reachedGitHub = new Promise<void>((resolve) => {
      reachGitHub = resolve;
    });
    let answerGitHub!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerGitHub = resolve;
    });
    // Each card query fails. The first one answers late.
    const queries: number[][] = [];
    mswServer.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        const { variables } = (await request.json()) as {
          variables: Record<string, unknown>;
        };
        queries.push(
          Object.entries(variables).flatMap(([name, value]) =>
            name.startsWith("number") ? [Number(value)] : [],
          ),
        );
        if (queries.length === 1) {
          reachGitHub();
          await answered;
        }
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    const app = await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    await sendGitHubWebhook(app, "pull_request", {
      action: "opened",
      pull_request: pullRequest(34),
    });

    // #34 is stale, and no card has read #35 yet.
    vi.setSystemTime(start + 61 * 60_000);
    const urls = [34, 35].map((number) => `${GITHUB_REPO}/pull/${number}`);
    const page = read(...urls);
    await reachedGitHub;
    vi.setSystemTime(Date.now() + 21_000);
    answerGitHub();
    const cards = (await page).objects;
    // The failed query does not split, and no card reads on its own.
    expect([queries, reads]).toEqual([[[34, 35]], []]);
    expect(cards.get(urls[0]!)).toMatchObject({
      title: "Cache GitHub objects",
    });
    expect(cards.has(urls[1]!)).toBe(false);
  });

  it("shows an unknown merge state from a single read as pending, then reads it again after 15 s", async () => {
    stubGitHubApp();
    // The page query has no card for #34, so it reads on its own. GitHub
    // still computes the merge state on the first read.
    const answers = [
      pullRequest(34, { mergeable: null }),
      pullRequest(34, { mergeable: true }),
    ];
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () => {
        reads.push("pulls/34");
        return HttpResponse.json(answers.shift());
      }),
    );
    stubGraphql({});
    await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });
    vi.setSystemTime(start + 10_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });
    expect(reads).toEqual(["pulls/34"]);

    vi.setSystemTime(start + 16_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
    expect(reads).toEqual(["pulls/34", "pulls/34"]);
  });

  it("reconciles pull requests in a heartbeat whose patch query fails", async () => {
    stubGitHubApp();
    vi.stubEnv("GITHUB_APP_BOT_EMAIL", BOT_EMAIL);
    // Every query fails.
    const operations: string[] = [];
    mswServer.use(
      http.get("https://api.github.com/repositories/2001", () =>
        HttpResponse.json({ full_name: "getsentry/junior", id: 2001 }),
      ),
      http.post("https://api.github.com/graphql", async ({ request }) => {
        const { operationName } = (await request.json()) as {
          operationName: string;
        };
        operations.push(operationName);
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    const app = await createGitHubApp();
    const queue = createConversationWorkQueueTestAdapter();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    await sendGitHubWebhook(app, "pull_request", {
      action: "opened",
      pull_request: pullRequest(34, {
        body: "Cache GitHub objects.\n\n<!-- junior-session-footer:start -->\nJunior\n<!-- junior-session-footer:end -->",
        user: { login: "junior-test[bot]" },
      }),
    });

    // A day later, the open pull request is due for its reconcile, and a
    // finished check suite adds a patch.
    vi.setSystemTime(start + 24.5 * 60 * 60_000);
    await sendGitHubWebhook(app, "check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "success",
        head_branch: "feat/object-cache",
        head_sha: "aaa111",
        id: 7002,
        pull_requests: [{ number: 34 }],
        status: "completed",
      },
    });
    vi.setSystemTime(Date.now() + 60_000);
    await runTestHeartbeat(queue, Date.now());
    expect(operations).toEqual([
      "PullRequestHeadFacts",
      "PullRequestLifecycles",
    ]);
  });

  it("shows an unknown merge state from a page read as pending, then reads it again after 15 s", async () => {
    stubGitHubApp();
    vi.stubEnv("GITHUB_APP_BOT_EMAIL", BOT_EMAIL);
    const card = (mergeable: string) => ({
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
      mergeable,
      merged: false,
      number: 34,
      reviewRequests: { nodes: [] },
      state: "OPEN",
      title: "Cache GitHub objects",
      updatedAt: "2026-01-02T03:30:00Z",
      url: `${GITHUB_REPO}/pull/34`,
    });
    // GitHub still computes the merge state on the first read.
    const answers = [card("UNKNOWN"), card("MERGEABLE")];
    const queries = stubGraphql({ cards: () => [answers.shift()!] });
    const app = await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    const queue = createConversationWorkQueueTestAdapter();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    await sendGitHubWebhook(app, "pull_request", {
      action: "opened",
      pull_request: pullRequest(34, {
        body: "Cache GitHub objects.\n\n<!-- junior-session-footer:start -->\nJunior\n<!-- junior-session-footer:end -->",
        user: { login: "junior-test[bot]" },
      }),
    });

    const readAt = start + 61 * 60_000;
    vi.setSystemTime(readAt);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });
    // The card read adds no patch, and the pending state holds for 15 s.
    vi.setSystemTime(readAt + 10_000);
    await runTestHeartbeat(queue, Date.now());
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });
    expect(queries.map((query) => query.operationName)).toEqual([
      "PullRequestCards",
    ]);

    vi.setSystemTime(readAt + 16_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
    expect(queries.map((query) => query.operationName)).toEqual([
      "PullRequestCards",
      "PullRequestCards",
    ]);
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
    const queries = stubGraphql({
      patches: [
        ...Array.from({ length: 4 }, () =>
          headFacts("bbb222", "UNKNOWN", "2026-01-02T03:00:10Z"),
        ),
        headFacts("ccc333", "UNKNOWN", "2026-01-02T03:04:30Z"),
        headFacts("ccc333", "MERGEABLE", "2026-01-02T03:04:30Z"),
      ],
    });
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
    expect(queries).toHaveLength(7);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
  });

  it("reads pending checks again when a webhook lands between a push and its patch", async () => {
    stubGitHubApp();
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () =>
        HttpResponse.json(pullRequest(34)),
      ),
    );
    const headFacts = (updatedAt: string) => [
      {
        commits: checkRuns({ SUCCESS: 4 }),
        headRefOid: "bbb222",
        id: "PR_34",
        mergeable: "MERGEABLE",
        updatedAt,
      },
    ];
    // The first read is from before the label.
    const queries = stubGraphql({
      patches: [
        headFacts("2026-01-02T03:00:10Z"),
        headFacts("2026-01-02T03:00:30Z"),
      ],
    });
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
    for (const [offset, action, mergeable] of [
      [10, "synchronize", null],
      [30, "labeled", true],
    ] as const) {
      vi.setSystemTime(start + offset * 1000);
      await sendGitHubWebhook(app, "pull_request", {
        action,
        pull_request: pullRequest(34, {
          head: { ref: "feat/object-cache", sha: "bbb222" },
          mergeable,
          updated_at: new Date(start + offset * 1000).toISOString(),
        }),
      });
    }
    vi.setSystemTime(start + 60_000);
    await runTestHeartbeat(queue, Date.now());
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: "pending",
    });
    vi.setSystemTime(start + 120_000);
    await runTestHeartbeat(queue, Date.now());
    expect(queries).toHaveLength(3);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 0, passed: 4, pending: 0 },
      mergeable: true,
    });
  });
});
