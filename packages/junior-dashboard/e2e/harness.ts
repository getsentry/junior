import { automationReport, mockAutomationApis } from "./automation-fixture";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  expect,
  type Page,
  type Request as PageRequest,
  type Route,
} from "@playwright/test";
import { NOW, NOW_MS } from "../src/mock-reporting/fixtures";
import { mockSearchRows } from "./search-fixture";
import type * as DashboardApp from "../src/app";

// The built dashboard. A plain string keeps the type check from needing a
// build; `DashboardApp` gives it the source's types.
const BUILT_APP = "../dist/app.js";

/**
 * Add the mailbox that a first detail read asks for, so a mocked detail report
 * answers that read the way the server does. The mailbox is empty by default.
 */
export function withRequestedMailbox<T extends { conversationId: string }>(
  route: Route,
  report: T,
  mailbox: unknown = {
    conversationId: report.conversationId,
    generatedAt: NOW,
    messages: [],
  },
): T {
  const { searchParams } = new URL(route.request().url());
  return searchParams.get("mailbox") === "true"
    ? { ...report, mailbox }
    : report;
}

/** The Conversation ids that a versions poll asks tokens for. */
export function requestedConversationIds(route: Route): string[] {
  const ids = new URL(route.request().url()).searchParams.get(
    "conversationIds",
  );
  return ids ? ids.split(",") : [];
}

/**
 * Answer the versions poll with one tree token for each requested
 * Conversation, so a mocked detail that sends the same token refreshes when
 * it moves, as on the server. Mock details send no token, so the others do
 * not refresh. The other tokens stay fixed.
 */
export async function routeConversationVersion(
  page: Page,
  conversationVersion: () => string,
): Promise<void> {
  await page.route("**/api/versions*", (route) =>
    route.fulfill({
      json: {
        conversationDetails: Object.fromEntries(
          requestedConversationIds(route).map((id) => [
            id,
            conversationVersion(),
          ]),
        ),
        conversations: "mock",
        inboxItems: "mock",
        spend: "mock",
      },
    }),
  );
}

/**
 * Wait until `count` versions checks are answered, then let the page finish
 * the work that the last answer started. A test that controls timers moves
 * the clock only after that, so the next poll timer is already set.
 */
export async function waitForVersionChecks(
  page: Page,
  checks: () => number,
  count: number,
) {
  await expect.poll(checks).toBe(count);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
}

/**
 * Wait for the next outline read of a Conversation. Each visit to its page
 * reads the outline once, so a test that ends on the page waits for it.
 */
export function waitForOutlineRead(page: Page, conversationId: string) {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/outline`;
  return page.waitForResponse(
    (response) => new URL(response.url()).pathname === path,
  );
}

/**
 * Wait for the page to save a read position past `afterSeq`. The page saves
 * one shortly after the reader sees new rows, such as a message they sent, so
 * a test that ends right after that waits for it.
 */
export function waitForReadPosition(page: Page, afterSeq: number) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "PUT" &&
      new URL(response.url()).pathname.endsWith("/read-position") &&
      request.postDataJSON().lastReadSeq > afterSeq
    );
  });
}

/**
 * Wait for the reads that the Settings page makes when it opens. Call it
 * before the navigation to Settings, and await it before the test ends or
 * skips there.
 */
export function waitForSettingsReads(page: Page) {
  return Promise.all(
    [
      "/api/notifications",
      "/api/user-customization",
      "/api/personal-tokens",
      "/api/connections",
    ].map((path) =>
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === path,
      ),
    ),
  );
}

/**
 * Scroll the window to the top over a few frames with no input event, as a
 * scrollbar drag does.
 */
export async function dragScrollbarToTop(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 10; frame++) {
      window.scrollTo(0, 0);
      await new Promise(requestAnimationFrame);
    }
  });
}

/** The requests that each page holds unanswered on purpose. */
const heldRoutes = new WeakMap<Page, { released: boolean; routes: Route[] }>();

/**
 * Leave each request to `url` unanswered, such as a page that never loads.
 * Teardown fails the held requests before the open-request check, so the
 * check still sees every other request that the test caused.
 */
export async function holdRequests(
  page: Page,
  url: string | RegExp,
): Promise<void> {
  const held = heldRoutes.get(page) ?? { released: false, routes: [] };
  heldRoutes.set(page, held);
  await page.route(url, async (route) => {
    if (held.released) await route.abort();
    else held.routes.push(route);
  });
}

/** Fail each request that a page holds, and each one that it starts after. */
export async function releaseHeldRequests(page: Page): Promise<void> {
  const held = heldRoutes.get(page);
  if (!held) return;
  held.released = true;
  await Promise.all(held.routes.splice(0).map((route) => route.abort()));
}

// How long teardown waits for open requests to end. The requests that raced
// teardown on CI ended 25 to 200 ms after it, so this leaves a wide margin
// for a slow runner. A request still open after this is hung, or held by a
// route that the test never released.
const DRAIN_MS = 3_000;

/**
 * The open requests of each tracked page, of every kind, and a way to wait
 * for one to end.
 */
const trackedPages = new WeakMap<
  Page,
  { loading: ReadonlySet<PageRequest>; nextEnd: () => Promise<void> }
>();

/**
 * Track the API requests of a page so a test cannot end while one that it
 * caused is open. Closing the page drops a write that the server has not
 * seen, and fails a route handler that is still running.
 */
export function trackOpenRequests(page: Page): {
  /**
   * Wait for each open request to end, and fail with each one still open
   * after `DRAIN_MS`.
   */
  expectNoneOpen: () => Promise<void>;
} {
  const open = new Set<PageRequest>();
  const loading = new Set<PageRequest>();
  const waiters = new Set<() => void>();
  const nextEnd = () => new Promise<void>((resolve) => waiters.add(resolve));
  const end = (request: PageRequest) => {
    open.delete(request);
    loading.delete(request);
    for (const wake of waiters) wake();
    waiters.clear();
  };
  page.on("request", (request) => {
    loading.add(request);
    // The app reads and writes with fetches. A page asset, such as an
    // image, can still load when the test ends with no harm.
    if (["fetch", "xhr"].includes(request.resourceType())) open.add(request);
  });
  page.on("requestfinished", end);
  page.on("requestfailed", end);
  trackedPages.set(page, { loading, nextEnd });
  return {
    expectNoneOpen: async () => {
      // Wait until none is open, not only for those open now: a request can
      // start another as it ends, such as a read that a write refreshes.
      const drained = async () => {
        while (open.size > 0) await nextEnd();
      };
      await Promise.race([
        drained(),
        delay(DRAIN_MS, undefined, { ref: false }),
      ]);
      if (open.size === 0) return;
      throw new Error(
        [
          "The test ended while requests that it caused were open:",
          ...requestLines(open),
          "Wait for the response or the visible result of each request.",
        ].join("\n"),
      );
    },
  };
}

function requestLines(requests: Iterable<PageRequest>): string[] {
  return [...requests].map((request) => {
    const { pathname, search } = new URL(request.url());
    return `  ${request.method()} ${pathname}${search}`;
  });
}

/**
 * Let the page run the work that a change queued, such as a render and its
 * effects. It posts messages, not timers: a test that controls timers stops
 * those, and React schedules its work with messages.
 */
export async function waitForRender(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let task = 0; task < 3; task++) {
      await new Promise<void>((resolve) => {
        // A window message, not a MessageChannel: the page can collect a
        // channel that nothing holds before its message arrives.
        const id = `junior-e2e-render-${task}-${Math.random()}`;
        const onMessage = (event: MessageEvent) => {
          if (event.data !== id) return;
          window.removeEventListener("message", onMessage);
          resolve();
        };
        window.addEventListener("message", onMessage);
        window.postMessage(id, "*");
      });
    }
  });
}

/**
 * Wait until the page has no request open, such as a fetch or a lazy code
 * chunk, and starts none as it renders the responses. Use it to assert that
 * the page sent no more requests, or to count all of them. Fail with each
 * one still open after `timeoutMs`.
 */
export async function waitForRequestsToEnd(
  page: Page,
  timeoutMs = DRAIN_MS,
): Promise<void> {
  const tracked = trackedPages.get(page);
  if (!tracked) throw new Error("The page fixture does not track this page.");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    while (tracked.loading.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          [
            `Requests were still open after ${timeoutMs}ms:`,
            ...requestLines(tracked.loading),
          ].join("\n"),
        );
      }
      await Promise.race([
        tracked.nextEnd(),
        delay(remaining, undefined, { ref: false }),
      ]);
    }
    await waitForRender(page);
    if (tracked.loading.size === 0) return;
  }
}

export type DashboardE2eServer = {
  baseURL: string;
  close(): Promise<void>;
};

/**
 * Reset mock reporting state mutated by prior tests.
 * The `dashboard` fixture shares one server process per worker, so mutations
 * from archive/restore or profile-update tests would otherwise leak into
 * unrelated specs and produce order-dependent screenshots. Import the built
 * dashboard (`dist/app.js`), not `../src/app`: that is the module instance
 * the running server actually reads, and importing it also defers to after
 * `startDashboardE2eServer` sets `DATABASE_URL`.
 */
export async function resetDashboardMockState(): Promise<void> {
  process.env["DATABASE_URL"] ??= "postgres://localhost/junior-dashboard-e2e";
  process.env["JUNIOR_ENCRYPTION_KEYS"] ??=
    "e2e:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI";
  const { resetMockDashboardState }: typeof DashboardApp = await import(
    BUILT_APP
  );
  resetMockDashboardState();
}

function requestFromNode(req: IncomingMessage, baseURL: string): Request {
  const url = new URL(req.url ?? "/", baseURL);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = req.method ?? "GET";
  // Node needs `duplex` to stream a request body; the DOM types lack it.
  const init: RequestInit & { duplex?: "half" } = {
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : (Readable.toWeb(req) as BodyInit),
    duplex: method === "GET" || method === "HEAD" ? undefined : "half",
    headers,
    method,
  };
  return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    res.setHeader(name, value);
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Starts the built dashboard with mock conversations for a browser spec. */
export async function startDashboardE2eServer(
  options: { authRequired?: boolean; basePath?: string } = {},
): Promise<DashboardE2eServer> {
  process.env["DATABASE_URL"] ??= "postgres://localhost/junior-dashboard-e2e";
  process.env["JUNIOR_ENCRYPTION_KEYS"] ??=
    "e2e:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI";
  const { createDashboardApp }: typeof DashboardApp = await import(BUILT_APP);
  const app = createDashboardApp({
    agentName: "Junior",
    allowedDomains: ["example.com"],
    auth: {
      async getSession() {
        return {
          user: {
            email: "dev@example.com",
            emailVerified: true,
            name: "Dashboard User",
          },
        };
      },
      async handler() {
        return Response.json({ ok: true });
      },
      async signInWithGoogle() {
        return Response.redirect("https://accounts.google.com", 302);
      },
    },
    authRequired: options.authRequired,
    basePath: options.basePath,
    mockConversations: true,
  });

  let baseURL = "http://127.0.0.1";
  const server = createServer((req, res) => {
    void Promise.resolve(app.fetch(requestFromNode(req, baseURL)))
      .then((response) => writeResponse(res, response))
      .catch((error) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.stack : String(error));
      });
  });
  // Keep idle connections open. route.fetch shares this worker's event loop
  // and reuses a keep-alive connection. When it sends on one just as the
  // idle timeout fires, the server closes it before it reads the request, and
  // route.fetch fails with ECONNRESET. The versions poll waits 5 s between
  // requests, so on a loaded machine it can land on the 6 s close.
  server.keepAliveTimeout = 0;

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      baseURL = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  return {
    baseURL,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // The page is still open and keeps reusing keep-alive connections.
        // Without this, close waits on them until the test times out.
        server.closeAllConnections();
      }),
  };
}

/** The memories of the mocked Memories page. */
const MEMORY_RECORDS = [
  {
    actions: [
      {
        confirmation: "Forget this memory?",
        href: "/api/memory/memories/memory-1",
        label: "Forget",
        method: "DELETE",
        tone: "danger",
      },
    ],
    id: "memory-1",
    title: "I prefer concise summaries.",
    metadata: [
      { label: "Type", value: "Preference" },
      { label: "Learned", value: "Automatic" },
      { label: "Source", value: "Slack" },
      { label: "Remembered", value: "Jul 29, 2026, 9:14 AM" },
    ],
  },
  {
    actions: [],
    id: "memory-2",
    title: "Release notes should include migration risks.",
    metadata: [
      { label: "Type", value: "Knowledge" },
      { label: "Learned", value: "Explicit" },
      { label: "Source", value: "Slack" },
      { label: "Remembered", value: "Jul 27, 2026, 4:42 PM" },
    ],
  },
  {
    actions: [],
    id: "memory-3",
    title: "Start incident reviews with the customer impact.",
    metadata: [
      { label: "Type", value: "Procedure" },
      { label: "Learned", value: "Automatic" },
      { label: "Source", value: "Slack" },
      { label: "Remembered", value: "Jul 24, 2026, 11:08 AM" },
    ],
  },
];

/** Stub shared APIs and pin browser current time for dashboard page specs. */
export async function mockDashboardApis(
  page: Page,
  options: { controlTimers?: boolean } = {},
) {
  // Pin Date for relative labels. Keep real timers unless a test needs fast-forward.
  if (options.controlTimers) {
    await page.clock.install({ time: NOW_MS });
  } else {
    await page.clock.setFixedTime(NOW_MS);
  }
  await page.route("**/api/user-pages", async (route) => {
    await route.fulfill({
      json: [
        {
          description: "Public memories Junior can use across conversations.",
          id: "memories",
          label: "Memories",
          navigation: "profile",
          pluginDisplayName: "Memory",
          pluginName: "memory",
        },
      ],
    });
  });
  await page.route("**/api/memory/conversations/*/memories", async (route) => {
    await route.fulfill({
      json: {
        events: [
          {
            memoryIds: ["memory-checkout-runbook"],
            seq: 2,
            source: "recalled",
            turnId: "active-turn",
          },
          {
            memoryIds: ["captured-memory-1", "captured-memory-2"],
            seq: 13,
            source: "captured",
            turnId: "qa-turn",
          },
        ],
        memories: [
          {
            content:
              "Checkout latency investigations start with the deployment comparison dashboard.",
            id: "memory-checkout-runbook",
            visibility: "public",
          },
          {
            content: "Use pnpm for repository commands.",
            id: "captured-memory-1",
            visibility: "private",
          },
          {
            content: "Dashboard transcript events should remain expandable.",
            id: "captured-memory-2",
            visibility: "public",
          },
        ],
      },
    });
  });
  await page.route("**/api/memory/memories/*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop() ?? "",
    );
    const memory =
      id === "memory-1"
        ? {
            content: "I prefer concise summaries.",
            createdAt: "2026-07-29T09:14:00.000Z",
            id: "memory-1",
            kind: "preference",
            observedAt: "2026-07-29T09:14:00.000Z",
            origin: "automatic",
            sourcePlatform: "slack",
          }
        : id === "memory-2"
          ? {
              content: "Release notes should include migration risks.",
              createdAt: "2026-07-27T16:42:00.000Z",
              id: "memory-2",
              kind: "knowledge",
              observedAt: "2026-07-27T16:42:00.000Z",
              origin: "explicit",
              sourcePlatform: "slack",
            }
          : id === "memory-3"
            ? {
                content: "Start incident reviews with the customer impact.",
                createdAt: "2026-07-24T11:08:00.000Z",
                id: "memory-3",
                kind: "procedure",
                observedAt: "2026-07-24T11:08:00.000Z",
                origin: "automatic",
                sourcePlatform: "slack",
              }
            : id === "memory-search"
              ? {
                  content: "Deploy runbooks live in Notion.",
                  createdAt: "2026-07-30T12:00:00.000Z",
                  id: "memory-search",
                  kind: "knowledge",
                  observedAt: "2026-07-30T12:00:00.000Z",
                  origin: "explicit",
                  sourcePlatform: "slack",
                }
              : undefined;
    if (!memory) {
      await route.fulfill({
        json: { error: "Memory was not found." },
        status: 404,
      });
      return;
    }
    await route.fulfill({ json: memory });
  });
  await page.route("**/api/user-pages/memory/memories*", async (route) => {
    await route.fulfill({
      json: {
        type: "list",
        emptyText: "No memories yet.",
        searchPlaceholder: "Search memories",
        records: MEMORY_RECORDS,
      },
    });
  });
  // Typed text finds the same memories through `/api/search`.
  await mockSearchRows(page, {
    memories: () => MEMORY_RECORDS.map(({ id, title }) => ({ id, title })),
  });
  await mockAutomationApis(page);
  await page.route("**/api/automations/*/executions", async (route) => {
    const url = new URL(route.request().url());
    const id = decodeURIComponent(
      url.pathname.split("/").filter(Boolean).at(-2) ?? "",
    );
    const kind = automationReport.automations.find(
      (automation) => automation.id === id,
    )?.kind;
    if (!kind) {
      await route.fulfill({
        status: 404,
        json: { error: "Automation not found." },
      });
      return;
    }
    const executionDays = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(NOW_MS - (89 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return {
        blocked: index % 13 === 0 ? 1 : 0,
        completed: index % 4 === 0 ? 2 : index % 2 === 0 ? 1 : 0,
        costUsd: index % 2 === 0 ? 0.21 : 0,
        date,
        failed: index % 9 === 0 ? 1 : 0,
      };
    });
    await route.fulfill({
      json: {
        executionDays,
        executions: [
          {
            conversationId: "scheduler:daily-ops-digest",
            costUsd: 0.42,
            durationMs: 42_000,
            executedAt: "2026-08-06T16:00:00.000Z",
            executionId: `${id}-run-1`,
            status: "completed",
            title: "Weekly project summary",
            totalTokens: 1_200,
          },
          {
            automationVersion: 3,
            conversationId: "slack:CQA123:1770003600.000200",
            costUsd: 0.18,
            credentialMode: "creator",
            durationMs: 18_000,
            error: "Slack rejected the result message: channel_not_found.",
            executedAt: "2026-08-05T16:00:00.000Z",
            executionId: `${id}-run-2`,
            scheduledFor: "2026-08-05T15:59:00.000Z",
            startedAt: "2026-08-05T15:59:42.000Z",
            status: "failed",
            title: "Ship notes for the release train",
            totalTokens: 480,
          },
          {
            executedAt: "2026-08-04T16:00:00.000Z",
            executionId: `${id}-run-3`,
            status: "blocked",
          },
        ],
        truncated: false,
      },
    });
  });
  await page.route("**/api/memory/dashboard", async (route) => {
    const start = Date.parse("2026-05-02T00:00:00.000Z");
    const days = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(start + index * 24 * 60 * 60 * 1_000);
      return {
        date: date.toISOString().slice(0, 10),
        count:
          index % 13 === 0 ? 3 : index % 4 === 0 ? 2 : index % 3 === 0 ? 1 : 0,
      };
    });
    await route.fulfill({
      json: {
        days,
        extractionDays: days.map((day, index) => ({
          costUsd: index % 6 === 0 ? 0.08 : index % 4 === 0 ? 0.03 : 0,
          date: day.date,
          events: index % 3 === 0 ? 2 : 1,
        })),
        generatedAt: "2026-07-30T12:00:00.000Z",
        recallDays: days.map((day, index) => ({
          costUsd: index % 5 === 0 ? 0.04 : index % 7 === 0 ? 0.015 : 0,
          date: day.date,
          events: index % 4 === 0 ? 3 : 1,
        })),
        stats: {
          active: 210,
          automatic: 189,
          createdThirtyDays: 41,
          embedded: 201,
          explicit: 20,
          knowledge: 154,
          preference: 12,
          procedure: 44,
        },
      },
    });
  });
  await page.route("**/api/stats", async (route) => {
    const end = new Date(NOW_MS);
    end.setUTCHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - 89);
    const stats = Array.from({ length: 90 }, (_, index) => {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + index);
      const date = day.toISOString().slice(0, 10);
      // Sparse, readable bars for the Workspace detail chart fixture.
      const count =
        index % 11 === 0 ? 5 : index % 7 === 0 ? 3 : index % 4 === 0 ? 1 : 0;
      return {
        count,
        date,
        metric: "workspace_switch",
        name: "11111111-1111-4111-8111-111111111111",
        namespace: "junior",
      };
    }).filter((stat) => stat.count > 0);
    await route.fulfill({
      json: {
        generatedAt: NOW,
        stats,
        windowEnd: end.toISOString().slice(0, 10),
        windowStart: start.toISOString().slice(0, 10),
      },
    });
  });
  await page.route("**/api/workspaces**", async (route) => {
    const workspace = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "sentry",
      repos: [
        {
          checkoutPath: "repos/sentry",
          provider: "github",
          repo: "getsentry/sentry",
        },
        {
          checkoutPath: "repos/getsentry",
          provider: "github",
          repo: "getsentry/getsentry",
        },
      ],
      setupScript: "pnpm install",
      vcpus: null,
      snapshot: {
        buildDurationMs: 45_000,
        generatedAt: "2026-08-15T05:40:21.000Z",
        id: "snap_workspace_123",
        sizeBytes: 4_194_304,
      },
    };
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/${workspace.id}`)) {
      await route.fulfill({ json: workspace });
      return;
    }
    await route.fulfill({
      json: {
        baselineSnapshot: {
          buildDurationMs: 102_799,
          dependencyCount: 38,
          generatedAt: "2026-08-15T05:30:21.000Z",
          id: "snap_baseline_Sj16Uz0PH1P3AKI6LgNoTvnqZ46h",
        },
        defaultVcpus: 4,
        workspaces: [{ ...workspace, snapshot: null }],
      },
    });
  });
  await page.route("**/api/personal-tokens**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        tokens: [
          {
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-10-30T00:00:00.000Z",
            id: "00000000-0000-4000-8000-000000000001",
            lastUsedAt: null,
            name: "Local agent",
            tokenSuffix: "abcd",
          },
        ],
      },
    });
  });
  await page.route("**/api/plugins", async (route) => {
    await route.fulfill({
      json: [
        {
          configKeys: ["github.organization"],
          description: "GitHub repository and development workflow context.",
          displayName: "GitHub",
          name: "github",
        },
        {
          configKeys: [],
          description: "Recurring and deferred Junior tasks.",
          displayName: "Scheduler",
          name: "scheduler",
        },
      ],
    });
  });
  await page.route("**/api/people", async (route) => {
    const activityDays = Array.from({ length: 90 }, (_, index) => {
      const date = new Date("2026-03-15T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + index);
      return {
        activePeople: (index % 4) + 1,
        conversations: (index % 6) + 2,
        date: date.toISOString().slice(0, 10),
      };
    });
    const activityHours = Array.from({ length: 7 * 24 }, (_, index) => {
      const date = new Date("2026-06-12T00:00:00.000Z");
      date.setUTCHours(date.getUTCHours() + index);
      return {
        activePeople: (index % 3) + 1,
        conversations: (index % 5) + 1,
        date: date.toISOString().slice(0, 13),
      };
    });
    await route.fulfill({
      json: {
        activityDays,
        activityHours,
        generatedAt: "2026-06-12T00:00:00.000Z",
        people: [
          {
            firstSeenAt: "2026-03-15T00:00:00.000Z",
            lastSeenAt: "2026-06-12T00:00:00.000Z",
            actor: {
              email: "avery@example.com",
              fullName: "Avery Example",
            },
            windows: {
              1: {
                conversations: 4,
                costUsd: 1.25,
                durationMs: 8_000,
                priorCostUsd: 0.4,
              },
              7: {
                conversations: 28,
                costUsd: 8.5,
                durationMs: 24_000,
                priorCostUsd: 3.1,
              },
              30: {
                conversations: 90,
                costUsd: 22.4,
                durationMs: 40_000,
                priorCostUsd: 18.2,
              },
              90: {
                conversations: 180,
                costUsd: 48.75,
                durationMs: 60_000,
                priorCostUsd: 12.1,
              },
            },
          },
        ],
        source: "conversation_index",
        windowEnd: "2026-06-12T00:00:00.000Z",
        windowStart: "2026-03-15T00:00:00.000Z",
      },
    });
  });
  await page.route("**/api/plugin-reports", async (route) => {
    await route.fulfill({
      json: {
        generatedAt: "2026-06-12T00:00:00.000Z",
        reports: [],
        source: "plugins",
      },
    });
  });
}
