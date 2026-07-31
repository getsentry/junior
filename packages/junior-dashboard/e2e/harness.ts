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
export async function startDashboardE2eServer(): Promise<DashboardE2eServer> {
  process.env.DATABASE_URL ??= "postgres://localhost/junior-dashboard-e2e";
  const { createDashboardApp } = await import("../dist/app.js");
  const app = createDashboardApp({
    allowedEmails: ["morgan@sentry.io"],
    auth: {
      async getSession() {
        return {
          user: {
            email: "morgan@sentry.io",
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
        {
          description: "Recurring work Junior runs for you.",
          id: "tasks",
          label: "Scheduled tasks",
          navigation: "profile",
          pluginDisplayName: "Scheduler",
          pluginName: "scheduler",
        },
      ],
    });
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
  await page.route("**/api/user-pages/scheduler/tasks", async (route) => {
    await route.fulfill({
      json: {
        type: "list",
        emptyText: "No scheduled tasks yet.",
        records: [
          {
            id: "task-1",
            title: "Send the weekly project summary",
            metadata: [{ label: "Schedule", value: "Every Monday" }],
          },
        ],
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
        public: index % 13 === 0 ? 3 : index % 4 === 0 ? 2 : index % 3 === 0 ? 1 : 0,
      };
    });
    await route.fulfill({
      json: {
        days,
        generatedAt: "2026-07-30T12:00:00.000Z",
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

/** Collects uncaught browser and console errors for a page assertion. */
export function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.stack ?? error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}
