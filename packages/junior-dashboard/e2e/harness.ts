import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Page } from "@playwright/test";

export type DashboardE2eServer = {
  baseURL: string;
  close(): Promise<void>;
};

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
  return new Request(url, {
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : (Readable.toWeb(req) as BodyInit),
    duplex: method === "GET" || method === "HEAD" ? undefined : "half",
    headers,
    method,
  });
}

async function writeResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Starts the built dashboard with mock conversations for a browser spec. */
export async function startDashboardE2eServer(
  options: { componentGallery?: boolean } = {},
): Promise<DashboardE2eServer> {
  process.env.DATABASE_URL ??= "postgres://localhost/junior-dashboard-e2e";
  const { createDashboardApp } = await import("../dist/app.js");
  const app = createDashboardApp({
    allowedEmails: ["dev@example.com"],
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
    componentGallery: options.componentGallery === true,
    mockConversations: true,
  });

  let baseURL = "http://127.0.0.1";
  const server = createServer((req, res) => {
    void app
      .fetch(requestFromNode(req, baseURL))
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
      }),
  };
}

/** Stubs APIs shared by dashboard page specs. */
export async function mockDashboardApis(page: Page) {
  await page.route("**/api/user-pages", async (route) => {
    await route.fulfill({
      json: [
        {
          description: "Personal facts Junior remembers about you.",
          id: "memories",
          label: "Memories",
          navigation: "primary",
          pluginDisplayName: "Memory",
          pluginName: "memory",
        },
      ],
    });
  });
  await page.route("**/api/plugins/memory/memories/*", async (route) => {
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
            visibility: "private",
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
              visibility: "public",
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
                visibility: "public",
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
                  visibility: "private",
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
    const filter = new URL(route.request().url()).searchParams.get("filter");
    const allRecords = [
      {
        actions: [
          {
            confirmation: "Forget this memory?",
            href: "/api/plugins/memory/memories/memory-1",
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
          { label: "Visibility", value: "Private" },
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
          { label: "Visibility", value: "Public" },
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
          { label: "Visibility", value: "Public" },
          { label: "Remembered", value: "Jul 24, 2026, 11:08 AM" },
        ],
      },
    ];
    const records = allRecords.filter((record) => {
      const metadata = Object.fromEntries(
        record.metadata.map((item) => [item.label, item.value]),
      );
      if (filter === "private") return metadata.Visibility === "Private";
      if (filter === "public") return metadata.Visibility === "Public";
      return true;
    });
    await route.fulfill({
      json: {
        type: "list",
        emptyText: "No memories yet.",
        searchPlaceholder: "Search memories",
        records,
      },
    });
  });
  await page.route("**/api/tasks", async (route) => {
    await route.fulfill({
      json: {
        executionDays: [
          { date: "2026-05-07", event: 1, scheduled: 0 },
          { date: "2026-05-08", event: 0, scheduled: 0 },
          { date: "2026-05-09", event: 0, scheduled: 2 },
          { date: "2026-05-10", event: 0, scheduled: 0 },
          { date: "2026-05-11", event: 1, scheduled: 4 },
          { date: "2026-05-12", event: 0, scheduled: 0 },
          { date: "2026-05-13", event: 0, scheduled: 1 },
          { date: "2026-05-14", event: 0, scheduled: 0 },
          { date: "2026-05-15", event: 1, scheduled: 3 },
          { date: "2026-05-16", event: 0, scheduled: 0 },
          { date: "2026-05-17", event: 0, scheduled: 0 },
          { date: "2026-05-18", event: 0, scheduled: 0 },
          { date: "2026-05-19", event: 1, scheduled: 2 },
          { date: "2026-05-20", event: 0, scheduled: 0 },
          { date: "2026-05-21", event: 0, scheduled: 4 },
          { date: "2026-05-22", event: 0, scheduled: 0 },
          { date: "2026-05-23", event: 1, scheduled: 1 },
          { date: "2026-05-24", event: 0, scheduled: 0 },
          { date: "2026-05-25", event: 0, scheduled: 3 },
          { date: "2026-05-26", event: 0, scheduled: 0 },
          { date: "2026-05-27", event: 1, scheduled: 0 },
          { date: "2026-05-28", event: 0, scheduled: 0 },
          { date: "2026-05-29", event: 0, scheduled: 2 },
          { date: "2026-05-30", event: 0, scheduled: 0 },
          { date: "2026-05-31", event: 1, scheduled: 4 },
          { date: "2026-06-01", event: 0, scheduled: 0 },
          { date: "2026-06-02", event: 0, scheduled: 1 },
          { date: "2026-06-03", event: 0, scheduled: 0 },
          { date: "2026-06-04", event: 1, scheduled: 3 },
          { date: "2026-06-05", event: 0, scheduled: 0 },
          { date: "2026-06-06", event: 0, scheduled: 0 },
          { date: "2026-06-07", event: 0, scheduled: 0 },
          { date: "2026-06-08", event: 1, scheduled: 2 },
          { date: "2026-06-09", event: 0, scheduled: 0 },
          { date: "2026-06-10", event: 0, scheduled: 4 },
          { date: "2026-06-11", event: 0, scheduled: 0 },
          { date: "2026-06-12", event: 1, scheduled: 1 },
          { date: "2026-06-13", event: 0, scheduled: 0 },
          { date: "2026-06-14", event: 0, scheduled: 3 },
          { date: "2026-06-15", event: 0, scheduled: 0 },
          { date: "2026-06-16", event: 1, scheduled: 0 },
          { date: "2026-06-17", event: 0, scheduled: 0 },
          { date: "2026-06-18", event: 0, scheduled: 2 },
          { date: "2026-06-19", event: 0, scheduled: 0 },
          { date: "2026-06-20", event: 1, scheduled: 4 },
          { date: "2026-06-21", event: 0, scheduled: 0 },
          { date: "2026-06-22", event: 0, scheduled: 1 },
          { date: "2026-06-23", event: 0, scheduled: 0 },
          { date: "2026-06-24", event: 1, scheduled: 3 },
          { date: "2026-06-25", event: 0, scheduled: 0 },
          { date: "2026-06-26", event: 0, scheduled: 0 },
          { date: "2026-06-27", event: 0, scheduled: 0 },
          { date: "2026-06-28", event: 1, scheduled: 2 },
          { date: "2026-06-29", event: 0, scheduled: 0 },
          { date: "2026-06-30", event: 0, scheduled: 4 },
          { date: "2026-07-01", event: 0, scheduled: 0 },
          { date: "2026-07-02", event: 1, scheduled: 1 },
          { date: "2026-07-03", event: 0, scheduled: 0 },
          { date: "2026-07-04", event: 0, scheduled: 3 },
          { date: "2026-07-05", event: 0, scheduled: 0 },
          { date: "2026-07-06", event: 1, scheduled: 0 },
          { date: "2026-07-07", event: 0, scheduled: 0 },
          { date: "2026-07-08", event: 0, scheduled: 2 },
          { date: "2026-07-09", event: 0, scheduled: 0 },
          { date: "2026-07-10", event: 1, scheduled: 4 },
          { date: "2026-07-11", event: 0, scheduled: 0 },
          { date: "2026-07-12", event: 0, scheduled: 1 },
          { date: "2026-07-13", event: 0, scheduled: 0 },
          { date: "2026-07-14", event: 1, scheduled: 3 },
          { date: "2026-07-15", event: 0, scheduled: 0 },
          { date: "2026-07-16", event: 0, scheduled: 0 },
          { date: "2026-07-17", event: 0, scheduled: 0 },
          { date: "2026-07-18", event: 1, scheduled: 2 },
          { date: "2026-07-19", event: 0, scheduled: 0 },
          { date: "2026-07-20", event: 0, scheduled: 4 },
          { date: "2026-07-21", event: 0, scheduled: 0 },
          { date: "2026-07-22", event: 1, scheduled: 1 },
          { date: "2026-07-23", event: 0, scheduled: 0 },
          { date: "2026-07-24", event: 0, scheduled: 3 },
          { date: "2026-07-25", event: 0, scheduled: 0 },
          { date: "2026-07-26", event: 1, scheduled: 0 },
          { date: "2026-07-27", event: 0, scheduled: 0 },
          { date: "2026-07-28", event: 0, scheduled: 2 },
          { date: "2026-07-29", event: 0, scheduled: 0 },
          { date: "2026-07-30", event: 1, scheduled: 4 },
          { date: "2026-07-31", event: 0, scheduled: 0 },
          { date: "2026-08-01", event: 0, scheduled: 1 },
          { date: "2026-08-02", event: 0, scheduled: 0 },
          { date: "2026-08-03", event: 1, scheduled: 3 },
          { date: "2026-08-04", event: 0, scheduled: 0 },
        ],
        tasks: [
          {
            createdAt: "2026-07-28T16:00:00.000Z",
            createdBy: "Morgan",
            createdByEmail: "dev@example.com",
            destination: {
              channelId: "C123",
              label: "#project-updates",
              teamId: "T123",
              visibility: "public",
            },
            id: "scheduled-1",
            instruction: "Send the weekly project summary",
            kind: "scheduled",
            lastConversationId: "scheduler:daily-ops-digest",
            lastRunAt: "2026-08-06T16:00:00.000Z",
            nextRunAt: "2026-08-10T16:00:00.000Z",
            ownedByViewer: true,
            runsLast7Days: 3,
            schedule: "Every Monday at 9:00 AM",
            status: "active",
            title: "Weekly project summary",
            totalRuns: 48,
          },
          {
            createdAt: "2026-07-29T16:00:00.000Z",
            createdBy: "Morgan",
            createdByEmail: "dev@example.com",
            destination: {
              channelId: "C123",
              label: "#project-updates",
              teamId: "T123",
              visibility: "public",
            },
            events: ["issue.closed"],
            id: "event-1",
            instruction: "Summarize the closed issue",
            kind: "event",
            ownedByViewer: true,
            resource: "Issue · ACME-42",
            runsLast7Days: 1,
            source: "github",
            title: "Closed issue summary",
            totalRuns: 7,
            triggerAvailable: true,
          },
          {
            createdAt: "2026-07-30T16:00:00.000Z",
            createdBy: "Avery Chen",
            createdByEmail: "avery@sentry.io",
            destination: {
              channelId: "C456",
              label: "#incident-response",
              teamId: "T123",
              visibility: "public",
            },
            events: ["incident.updated"],
            id: "event-2",
            instruction: "Notify responders when the incident changes",
            kind: "event",
            ownedByViewer: false,
            resource: "Incident · INC-17",
            runsLast7Days: 0,
            source: "pagerduty",
            title: "Incident change alerts",
            totalRuns: 0,
            triggerAvailable: false,
          },
        ],
        truncated: false,
      },
    });
  });
  await page.route("**/api/tasks/*/*/executions", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/").filter(Boolean);
    const kind = parts.at(-3);
    const id = parts.at(-2);
    if ((kind !== "scheduled" && kind !== "event") || !id) {
      await route.fulfill({ status: 404, json: { error: "Task not found." } });
      return;
    }
    const task = {
      createdAt: "2026-07-28T16:00:00.000Z",
      createdBy: "Morgan",
      createdByEmail: "dev@example.com",
      destination: {
        channelId: "C123",
        label: "#project-updates",
        teamId: "T123",
        visibility: "public" as const,
      },
      id,
      instruction:
        kind === "scheduled"
          ? "Send the weekly project summary"
          : "Summarize the closed issue",
      kind,
      ownedByViewer: true,
      runsLast7Days: kind === "scheduled" ? 3 : 1,
      title:
        kind === "scheduled"
          ? "Weekly project summary"
          : "Closed issue summary",
      totalRuns: kind === "scheduled" ? 48 : 7,
      ...(kind === "scheduled"
        ? {
            nextRunAt: "2026-08-10T16:00:00.000Z",
            schedule: "Every Monday at 9:00 AM",
            status: "active" as const,
          }
        : {
            events: ["issue.closed"],
            resource: "Issue · ACME-42",
            source: "github",
            triggerAvailable: true,
          }),
    };
    const nowMs = Date.parse("2026-08-07T12:00:00.000Z");
    const executionDays = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(nowMs - (89 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return {
        blocked: index % 13 === 0 ? 1 : 0,
        completed: index % 4 === 0 ? 2 : index % 2 === 0 ? 1 : 0,
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
            executedAt: "2026-08-06T16:00:00.000Z",
            executionId: `${id}-run-1`,
            status: "completed",
            title: "Weekly project summary",
          },
          {
            conversationId: "slack:CQA123:1770003600.000200",
            executedAt: "2026-08-05T16:00:00.000Z",
            executionId: `${id}-run-2`,
            status: "failed",
            title: "Ship notes for the release train",
          },
          {
            executedAt: "2026-08-04T16:00:00.000Z",
            executionId: `${id}-run-3`,
            status: "blocked",
          },
        ],
        task,
        truncated: false,
      },
    });
  });
  await page.route("**/api/plugins/memory/dashboard", async (route) => {
    const start = Date.parse("2026-05-02T00:00:00.000Z");
    const days = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(start + index * 24 * 60 * 60 * 1_000);
      return {
        date: date.toISOString().slice(0, 10),
        personal: index % 9 === 0 ? 2 : index % 5 === 0 ? 1 : 0,
        public:
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
          personal: 24,
          preference: 12,
          procedure: 44,
          public: 186,
        },
      },
    });
  });
  await page.route("**/api/stats", async (route) => {
    const end = new Date();
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
        generatedAt: end.toISOString(),
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
        workspaces: [{ ...workspace, snapshot: null }],
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
    await route.fulfill({
      json: {
        activityDays,
        generatedAt: "2026-06-12T00:00:00.000Z",
        people: [
          {
            active: 0,
            activeDays: 90,
            conversations: 180,
            durationMs: 60_000,
            failed: 0,
            firstSeenAt: "2026-03-15T00:00:00.000Z",
            lastSeenAt: "2026-06-12T00:00:00.000Z",
            actor: {
              email: "avery@example.com",
              fullName: "Avery Example",
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
