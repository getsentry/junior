import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { expect, test } from "@playwright/test";
import type { JuniorReporting } from "@sentry/junior/reporting";
import { createDashboardApp } from "../dist/app.js";

let server: ReturnType<typeof createServer> | undefined;
let baseURL = "http://127.0.0.1";

function reporting(): JuniorReporting {
  return {
    async getHealth() {
      return {
        service: "junior",
        status: "ok",
        timestamp: "2026-06-12T00:00:00.000Z",
      };
    },
    async getRuntimeInfo() {
      return {
        cwd: "/workspace",
        descriptionText: "Dashboard e2e",
        homeDir: "/workspace",
        packagedContent: {
          manifestRoots: [],
          packageNames: [],
          packages: [],
          skillRoots: [],
          tracingIncludes: [],
        },
        providers: ["github"],
        skills: [],
      };
    },
    async getPlugins() {
      return [{ name: "github" }];
    },
    async getSkills() {
      return [];
    },
    async listConversations() {
      return {
        conversations: [],
        generatedAt: "2026-06-12T00:00:00.000Z",
        source: "conversation_index",
      };
    },
    async getConversationStats() {
      return {
        active: 0,
        conversations: 0,
        durationMs: 0,
        failed: 0,
        generatedAt: "2026-06-12T00:00:00.000Z",
        hung: 0,
        locations: [],
        requesters: [],
        runs: 0,
        sampleLimit: 0,
        sampleSize: 0,
        source: "conversation_index",
        truncated: false,
        windowEnd: "2026-06-12T00:00:00.000Z",
        windowStart: "2026-06-05T00:00:00.000Z",
      };
    },
    async getPluginOperationalReports() {
      return {
        generatedAt: "2026-06-12T00:00:00.000Z",
        reports: [],
        source: "plugins",
      };
    },
    async getConversation(conversationId) {
      return {
        generatedAt: "2026-06-12T00:00:00.000Z",
        id: conversationId,
        runs: [],
        transcript: [],
        transcriptAvailable: true,
      };
    },
    async getConversationSubagentTranscript(
      _conversationId,
      _runId,
      subagentId,
    ) {
      return {
        type: "subagent",
        createdAt: "2026-06-12T00:00:00.000Z",
        id: subagentId,
        status: "error",
        subagentKind: "unknown",
        transcript: [],
        transcriptAvailable: false,
        unavailableReason: "not_found",
      };
    },
  };
}

function requestFromNode(req: IncomingMessage): Request {
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

test.beforeAll(async () => {
  const app = createDashboardApp({
    authRequired: false,
    mockConversations: true,
    reporting: reporting(),
  });

  server = createServer((req, res) => {
    void app
      .fetch(requestFromNode(req))
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
});

test.afterAll(async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("hydrates the built dashboard client in a real browser", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => {
    browserErrors.push(error.stack ?? error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });

  await page.goto(baseURL);

  await expect(page.getByRole("heading", { name: "Junior" })).toBeVisible();
  await expect(page.getByText("Latest Conversations")).toBeVisible();
  await expect(
    page.getByLabel("conversations by duration over the last 7 days"),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});
