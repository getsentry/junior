import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb } from "@/chat/db";
import {
  cardNode,
  checkRuns,
  createGitHubApp,
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  pullRequest,
  sendGitHubWebhook,
  stubGitHubApp,
  stubGraphql,
  T0,
  viewerApi,
} from "../../fixtures/github-objects";
import { createPluginTaskQueueTestAdapter } from "../../fixtures/plugin-task-queue";
import { mswServer } from "../../msw/server";

const DASHBOARD = "https://junior.example.com";
const BOT_EMAIL = "41898282+junior-test[bot]@users.noreply.github.com";

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

  it("shows merge state and checks as pending after a push, then one patch task fills them", async () => {
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
            number: 34,
            mergeable: "CONFLICTING",
            updatedAt: "2026-01-02T03:00:12Z",
          },
        ],
        [
          {
            commits: checkRuns({ FAILURE: 1, SUCCESS: 5 }),
            headRefOid: "ccc333",
            number: 34,
            mergeable: "CONFLICTING",
            updatedAt: "2026-01-02T03:00:12Z",
          },
        ],
      ],
    });
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });

    // A push and an edit of its head inside one 5 s window. GitHub
    // computes mergeability later.
    for (const [offset, action] of [
      [10, "synchronize"],
      [12, "edited"],
    ] as const) {
      vi.setSystemTime(start + offset * 1000);
      await sendGitHubWebhook(app, "pull_request", {
        action,
        pull_request: pullRequest(34, {
          additions: 130,
          head: { ref: "feat/object-cache", sha: "ccc333" },
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
    // Both events share one task, which starts 5 s later.
    expect(tasks.sent().map(({ options }) => options?.delaySeconds)).toEqual([
      5,
    ]);

    vi.setSystemTime(start + 60_000);
    await tasks.deliver();
    // The page query has no card for #34, so it read on its own. Then one
    // query reads only the merge state and checks, not the whole entry.
    expect(queries).toEqual([
      { numbers: [34], operationName: "PullRequestCards" },
      { numbers: [34], operationName: "PullRequestHeadFacts" },
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
    await tasks.deliver();
    expect(queries).toHaveLength(3);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 1, passed: 5, pending: 0 },
      mergeable: false,
    });
    expect(reads).toEqual(["pulls/34"]);
  });

  it("patches the checks of entries with no node id by repository and number", async () => {
    stubGitHubApp();
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/:number`, ({ params }) =>
        // An entry from before reads by number has no GraphQL id.
        HttpResponse.json(
          pullRequest(Number(params["number"]), { node_id: undefined }),
        ),
      ),
    );
    const headFacts = (number: number, counts: Record<string, number>) => ({
      commits: checkRuns(counts),
      headRefOid: "aaa111",
      mergeable: "MERGEABLE",
      number,
      updatedAt: T0,
    });
    const queries = stubGraphql({
      patches: Array.from({ length: 2 }, () => [
        headFacts(34, { SUCCESS: 3 }),
        headFacts(35, { FAILURE: 2 }),
      ]),
    });
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const urls = [35, 34].map((number) => `${GITHUB_REPO}/pull/${number}`);
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    for (const url of urls) await read(url);

    await sendGitHubWebhook(app, "check_suite", {
      action: "completed",
      check_suite: {
        conclusion: "failure",
        head_branch: "feat/object-cache",
        head_sha: "aaa111",
        id: 7002,
        pull_requests: [{ number: 35 }, { number: 34 }],
        status: "completed",
      },
    });
    vi.setSystemTime(start + 60_000);
    await tasks.deliver();
    // Each pull request gets its own task, and the answer of each goes to
    // its own pull request.
    expect(
      queries.filter((query) => query.operationName === "PullRequestHeadFacts"),
    ).toEqual([
      { numbers: [35], operationName: "PullRequestHeadFacts" },
      { numbers: [34], operationName: "PullRequestHeadFacts" },
    ]);
    const [card35, card34] = await Promise.all(
      urls.map(async (url) => (await read(url)).objects.get(url)?.facts),
    );
    expect(card34).toMatchObject({
      checks: { failed: 0, passed: 3, pending: 0 },
    });
    expect(card35).toMatchObject({
      checks: { failed: 2, passed: 0, pending: 0 },
    });
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

  it.each([
    // The patch query answers with no node for #34.
    ["finds no node", []],
    // A push that GitHub has and no webhook brought yet.
    [
      "reads another head commit",
      [
        {
          commits: checkRuns({ SUCCESS: 1 }),
          headRefOid: "ccc333",
          mergeable: "MERGEABLE",
          number: 34,
          updatedAt: "2026-01-02T03:00:11Z",
        },
      ],
    ],
  ])("reads a pull request again soon after its patch %s", async (_, patch) => {
    stubGitHubApp();
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () => {
        reads.push("pulls/34");
        return HttpResponse.json(
          pullRequest(34, {
            head: { ref: "feat/object-cache", sha: "bbb222" },
            updated_at: "2026-01-02T03:00:10Z",
          }),
        );
      }),
    );
    const queries = stubGraphql({ patches: [patch] });
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start + 10_000);
    await sendGitHubWebhook(app, "pull_request", {
      action: "synchronize",
      pull_request: pullRequest(34, {
        head: { ref: "feat/object-cache", sha: "bbb222" },
        mergeable: null,
        updated_at: "2026-01-02T03:00:10Z",
      }),
    });
    vi.setSystemTime(start + 60_000);
    await tasks.deliver();
    expect(queries.map((query) => query.operationName)).toEqual([
      "PullRequestHeadFacts",
    ]);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: "pending",
      mergeable: "pending",
    });
    expect(reads).toEqual([]);

    vi.setSystemTime(start + 76_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
    expect(reads).toEqual(["pulls/34"]);
  });

  it("retries a failed patch query, and its last delivery keeps pending only 15 s", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () => {
        reads.push("pulls/34");
        return HttpResponse.json(pullRequest(34));
      }),
      // Every patch query fails.
      http.post("https://api.github.com/graphql", () =>
        HttpResponse.json({ message: "Server Error" }, { status: 502 }),
      ),
    );
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start + 10_000);
    await sendGitHubWebhook(app, "pull_request", {
      action: "synchronize",
      pull_request: pullRequest(34, {
        head: { ref: "feat/object-cache", sha: "bbb222" },
        mergeable: null,
        updated_at: "2026-01-02T03:00:10Z",
      }),
    });
    for (let delivery = 1; delivery <= 4; delivery++) {
      vi.setSystemTime(start + delivery * 60_000);
      expect(await tasks.deliver()).toBe(1);
    }
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });

    vi.setSystemTime(start + 5 * 60_000);
    expect(await tasks.deliver()).toBe(1);
    expect(await tasks.deliver()).toBe(0);
    vi.setSystemTime(start + 5 * 60_000 + 16_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
    expect(reads).toEqual(["pulls/34"]);
  });

  it("starts one patch task per head commit and 5 s window of events", async () => {
    stubGitHubApp();
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () =>
        HttpResponse.json(pullRequest(34)),
      ),
    );
    stubGraphql({});
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);
    await read(`${GITHUB_REPO}/pull/34`);
    // The second event shares the first task. The third is 6 s later.
    for (const offset of [1, 3, 9]) {
      vi.setSystemTime(start + offset * 1000);
      await sendGitHubWebhook(app, "check_run", {
        action: "completed",
        check_run: {
          head_sha: "aaa111",
          id: 8000 + offset,
          pull_requests: [{ number: 34 }],
        },
      });
    }
    const patch = {
      delaySeconds: 5,
      payload: { key: "pulls:getsentry/junior#34", sha: "aaa111" },
    };
    expect(
      tasks.sent().map(({ message, options }) => ({
        delaySeconds: options?.delaySeconds,
        payload: "payload" in message ? message.payload : undefined,
      })),
    ).toEqual([patch, patch]);
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
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
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
    await tasks.deliver();
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
        number: 34,
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
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
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
      await tasks.deliver();
    }
    await push("ccc333", start + 4 * 60_000 + 30_000);
    // The first task makes its last delivery, which reads nothing because
    // the new push's task owns the entry now. The new task makes its first.
    vi.setSystemTime(start + 5 * 60_000);
    expect(await tasks.deliver()).toBe(2);
    // The new head commit is still computing, so it is still pending.
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });
    vi.setSystemTime(start + 6 * 60_000);
    expect(await tasks.deliver()).toBe(1);
    // One card read, then six patch reads.
    expect(queries).toHaveLength(7);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
  });

  it("keeps a new push's pending fields when the old push's task fails its last delivery", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/34`, () => {
        reads.push("pulls/34");
        return HttpResponse.json(pullRequest(34));
      }),
      // Every patch query fails.
      http.post("https://api.github.com/graphql", () =>
        HttpResponse.json({ message: "Server Error" }, { status: 502 }),
      ),
    );
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
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
      await tasks.deliver();
    }
    await push("ccc333", start + 4 * 60_000 + 30_000);
    // The old push's task makes its last delivery after the new push.
    vi.setSystemTime(start + 5 * 60_000);
    expect(await tasks.deliver()).toBe(2);

    vi.setSystemTime(start + 5 * 60_000 + 16_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
      checks: "pending",
    });
    expect(reads).toEqual([]);
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
        number: 34,
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
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
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
    await tasks.deliver();
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: "pending",
    });
    vi.setSystemTime(start + 120_000);
    await tasks.deliver();
    expect(queries).toHaveLength(3);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 0, passed: 4, pending: 0 },
      mergeable: true,
    });
  });
  it("keeps known checks and merge state when a webhook on the same head says mergeable null", async () => {
    stubGitHubApp();
    const queries = stubGraphql({ cards: [cardNode(34)] });
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-01-02T06:00:00Z");
    vi.setSystemTime(start);
    await read(url);

    // A label changes nothing that GitHub computes.
    vi.setSystemTime(start + 10_000);
    await sendGitHubWebhook(app, "pull_request", {
      action: "labeled",
      pull_request: pullRequest(34, {
        head: { ref: "feat/34", sha: "ddd444" },
        mergeable: null,
        updated_at: new Date(start + 10_000).toISOString(),
      }),
    });
    vi.setSystemTime(start + 60_000);
    await tasks.deliver();
    expect(queries.map((query) => query.operationName)).toEqual([
      "PullRequestCards",
    ]);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 0, passed: 2, pending: 0 },
      mergeable: true,
    });
  });
  it("keeps known checks and patches the merge state after a base retarget", async () => {
    stubGitHubApp();
    const queries = stubGraphql({
      cards: [cardNode(34)],
      patches: [
        [
          {
            commits: checkRuns({ SUCCESS: 2 }),
            headRefOid: "ddd444",
            mergeable: "CONFLICTING",
            number: 34,
            updatedAt: "2026-01-02T06:00:10Z",
          },
        ],
      ],
    });
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-01-02T06:00:00Z");
    vi.setSystemTime(start);
    await read(url);

    // A new base changes the merge state of the same head, not its checks.
    vi.setSystemTime(start + 10_000);
    await sendGitHubWebhook(app, "pull_request", {
      action: "edited",
      pull_request: pullRequest(34, {
        base: { ref: "release" },
        head: { ref: "feat/34", sha: "ddd444" },
        mergeable: null,
        updated_at: new Date(start + 10_000).toISOString(),
      }),
    });
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 0, passed: 2, pending: 0 },
      mergeable: "pending",
    });
    vi.setSystemTime(start + 60_000);
    await tasks.deliver();
    expect(queries.map((query) => query.operationName)).toEqual([
      "PullRequestCards",
      "PullRequestHeadFacts",
    ]);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      checks: { failed: 0, passed: 2, pending: 0 },
      mergeable: false,
    });
  });
  it("asks GitHub again soon after the last patch delivery finds the merge state still computing", async () => {
    stubGitHubApp();
    const unknown = {
      commits: checkRuns({ SUCCESS: 1 }),
      headRefOid: "bbb222",
      mergeable: "UNKNOWN",
      number: 34,
      updatedAt: "2026-01-02T06:00:10Z",
    };
    const queries = stubGraphql({
      // The first read is from before the push.
      cards: () => [
        queries.length > 1
          ? {
              ...cardNode(34),
              headRefOid: "bbb222",
              updatedAt: "2026-01-02T06:00:20Z",
            }
          : { ...cardNode(34), headRefOid: "aaa111" },
      ],
      patches: Array.from({ length: 5 }, () => [unknown]),
    });
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-01-02T06:00:00Z");
    vi.setSystemTime(start);
    await read(url);
    vi.setSystemTime(start + 10_000);
    await sendGitHubWebhook(app, "pull_request", {
      action: "synchronize",
      pull_request: pullRequest(34, {
        head: { ref: "feat/34", sha: "bbb222" },
        mergeable: null,
        updated_at: "2026-01-02T06:00:10Z",
      }),
    });
    for (let minute = 1; minute <= 5; minute++) {
      vi.setSystemTime(start + minute * 60_000);
      await tasks.deliver();
    }
    const named = (operationName: string) =>
      queries.filter((query) => query.operationName === operationName);
    expect(named("PullRequestHeadFacts")).toHaveLength(5);
    const before = named("PullRequestCards").length;
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: "pending",
    });

    vi.setSystemTime(start + 5 * 60_000 + 16_000);
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      mergeable: true,
    });
    expect(named("PullRequestCards")).toHaveLength(before + 1);
  });
});
