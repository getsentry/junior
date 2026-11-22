import { automationReport, mockAutomationApis } from "./automation-fixture";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Page, Request as PageRequest, Route } from "@playwright/test";
import { NOW, NOW_MS } from "../src/mock-reporting/fixtures";
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
 * Reads that the dashboard starts or repeats in the background, so one can be
 * open whenever a test ends. Only GET reads belong here: a test must await
 * every write that it causes, or the server may never see it.
 */
const BACKGROUND_READS: readonly RegExp[] = [
  // The versions poll runs for the whole visit (`useVersionsPoll`).
  /^\/api\/versions$/,
  // A live Conversation polls its detail. When idle, the versions poll
  // refreshes it.
  /^\/api\/conversations\/[^/]+$/,
  // A detail with a new ETag refreshes its side reads
  // (`refreshSideReadsOnChange`).
  /^\/api\/conversations\/[^/]+\/(agents|todos|watches)$/,
  /^\/api\/memory\/conversations\/[^/]+\/memories$/,
  // A moved versions token refreshes the feeds, every Inbox item read (the
  // lists, the count, the waiting Conversations, and each item), and the
  // viewer's spend (`refreshChangedReads`).
  /^\/api\/conversations$/,
  /^\/api\/inbox-items(\/[^/]+)?$/,
  /^\/api\/people\/me\/spend$/,
  // A pointer that rests on an Automation row prefetches its page
  // (`usePrefetchAutomation`). A Conversation row prefetches its detail.
  /^\/api\/automations\/(?!(event-catalog|runs)$)[^/]+(\/executions)?$/,
];

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

/** Whether a request is a background read that may outlive a test. */
function isBackgroundRead(request: PageRequest): boolean {
  const { pathname } = new URL(request.url());
  return (
    request.method() === "GET" &&
    BACKGROUND_READS.some((path) => path.test(pathname))
  );
}

// How long a request that has its response may take to end its body.
const BODY_GRACE_MS = 1_000;

/**
 * Track the API requests of a page so a test cannot end while one that it
 * caused is open. A request that a test does not wait for races its end:
 * closing the page drops a write that the server has not seen, and fails a
 * route handler that is still running.
 */
export function trackOpenRequests(page: Page): {
  /** Fail with each open request other than a background read. */
  expectNoneOpen: () => Promise<void>;
} {
  const open = new Set<PageRequest>();
  // The body of each request that got a response, once it ends.
  const bodies = new Map<PageRequest, Promise<unknown>>();
  page.on("request", (request) => {
    // The app reads and writes with fetches. A page asset, such as an
    // image, can still load when the test ends with no harm.
    if (["fetch", "xhr"].includes(request.resourceType())) open.add(request);
  });
  page.on("response", (response) =>
    bodies.set(
      response.request(),
      // The page can close before the body ends.
      response.finished().catch(() => undefined),
    ),
  );
  page.on("requestfinished", (request) => open.delete(request));
  page.on("requestfailed", (request) => open.delete(request));
  return {
    expectNoneOpen: async () => {
      const unexpected = [...open].filter(
        (request) => !isBackgroundRead(request),
      );
      // A test that awaited a response can end before its body is read and
      // `requestfinished` fires. Give each body that started a short time to
      // end. A request with no response gets none: it is still open.
      await Promise.all(
        unexpected.flatMap((request) => {
          const body = bodies.get(request);
          return body ? [Promise.race([body, delay(BODY_GRACE_MS)])] : [];
        }),
      );
      const stillOpen = unexpected.filter((request) => open.has(request));
      if (stillOpen.length === 0) return;
      const lines = stillOpen.map((request) => {
        const { pathname, search } = new URL(request.url());
        return `  ${request.method()} ${pathname}${search}`;
      });
      throw new Error(
        [
          "The test ended while requests that it caused were open:",
          ...lines,
          "Wait for the response or the visible result of each request.",
        ].join("\n"),
      );
    },
  };
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
    const records = [
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
    await route.fulfill({
      json: {
        type: "list",
        emptyText: "No memories yet.",
        searchPlaceholder: "Search memories",
        records,
      },
    });
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
