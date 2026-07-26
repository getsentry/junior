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
  await page.route("**/api/plugins", async (route) => {
    await route.fulfill({
      json: [
        {
          capabilities: ["github.issues", "github.pull-requests"],
          configKeys: ["github.organization"],
          description: "GitHub repository and development workflow context.",
          displayName: "GitHub",
          name: "github",
        },
        {
          capabilities: ["scheduler.scheduled-tasks"],
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
