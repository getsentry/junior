import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { expect, test } from "@playwright/test";
import { createDashboardApp } from "../dist/app.js";

let server: ReturnType<typeof createServer> | undefined;
let baseURL = "http://127.0.0.1";

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
    allowedEmails: ["morgan@sentry.io"],
    auth: {
      async getSession() {
        return {
          user: {
            email: "morgan@sentry.io",
            emailVerified: true,
            hostedDomain: "sentry.io",
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

test.beforeEach(async ({ page }) => {
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
});

test("hydrates the built dashboard client in a real browser", async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
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
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    `${baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();
  const containerBounds = () =>
    page.locator("main > div").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, width: bounds.width };
    });
  const headerBounds = await page
    .locator("main > header > div")
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, width: bounds.width };
    });
  expect(headerBounds).toEqual({ left: 160, width: 1280 });
  expect(await containerBounds()).toEqual(headerBounds);

  await expect(page.getByRole("link", { name: "Conversations" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "Plugins" })).toHaveCount(0);
  await page.getByRole("link", { name: "System", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/system`);
  await expect(page.getByText("Runtime health")).toBeVisible();
  await expect(page.getByText("Plugins", { exact: true })).toBeVisible();
  await expect(page.getByText("estimated cost")).toBeVisible();
  expect(await containerBounds()).toEqual(headerBounds);

  await page.goto(`${baseURL}/people`);
  await expect(
    page.locator("main > div").getByText("People", { exact: true }),
  ).toBeVisible();
  expect(await containerBounds()).toEqual(headerBounds);

  await expect(
    page.getByRole("img", { name: "Active people per day" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "90d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("combobox", { name: "Sort people" })).toHaveValue(
    "conversations",
  );
  await page.getByRole("button", { name: "7d" }).click();
  await expect(page.getByRole("button", { name: "7d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "90d" }).click();
  await expect(page.getByRole("button", { name: "90d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.goto(`${baseURL}/locations`);
  await expect(
    page.locator("main > div").getByText("Locations", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Public and private conversations per day" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Sort locations" }),
  ).toHaveValue("conversations");
  expect(await containerBounds()).toEqual(headerBounds);
  expect(browserErrors).toEqual([]);
});

test("opens and closes a conversation in the mobile workspace", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${baseURL}/conversations`);
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();

  await page.getByRole("link", { name: /Checkout latency triage/ }).click();
  await expect(page).toHaveURL(
    `${baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Your conversations" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();

  await page.goto(`${baseURL}/system`);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("scrolls long conversation and transcript panes independently", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1440 });
  const generatedAt = "2026-06-12T00:00:00.000Z";
  const conversations = Array.from({ length: 40 }, (_, index) => ({
    conversationId: `long-${index}`,
    cumulativeDurationMs: 1_000 + index,
    displayTitle: `Conversation ${String(index + 1).padStart(2, "0")}`,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    startedAt: generatedAt,
    status: "completed",
    surface: "internal",
  }));

  await page.route("**/api/conversations?*", async (route) => {
    await route.fulfill({
      json: {
        conversations,
        generatedAt,
        source: "conversation_index",
      },
    });
  });
  await page.route("**/api/conversations/long-0", async (route) => {
    await route.fulfill({
      json: {
        ...conversations[0],
        displayTitle: "Long transcript",
        generatedAt,
        transcript: Array.from({ length: 60 }, (_, index) => ({
          parts: [
            {
              text: `Transcript message ${index + 1} with enough content to occupy a visible row.`,
              type: "text",
            },
          ],
          role: index % 2 === 0 ? "user" : "assistant",
          timestamp: Date.parse(generatedAt) + index * 1_000,
        })),
        transcriptAvailable: true,
      },
    });
  });

  await page.goto(`${baseURL}/conversations/long-0`);
  await expect(
    page.getByRole("heading", { name: "Long transcript" }),
  ).toBeVisible();

  const conversationList = page
    .getByRole("navigation", { name: "Your conversations" })
    .locator("..");
  const transcript = page.getByLabel("Conversation transcript");
  const geometry = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: document.documentElement.clientHeight,
  }));
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  await expect
    .poll(() =>
      conversationList.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);

  await conversationList.evaluate((element) => {
    element.scrollTop = 240;
  });
  expect(await conversationList.evaluate((element) => element.scrollTop)).toBe(
    240,
  );
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await transcript.evaluate((element) => {
    element.scrollTop = 320;
  });
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(320);
  expect(await conversationList.evaluate((element) => element.scrollTop)).toBe(
    240,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("groups the signed-in profile and session actions in the header", async ({
  page,
}) => {
  await page.goto(baseURL);

  const trigger = page.getByRole("button", {
    name: "Open profile menu for Dashboard User",
  });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();

  const popover = page.locator("#profile-popover");
  await expect(popover.getByText("morgan@sentry.io")).toBeVisible();
  await expect(
    popover.getByRole("link", { name: "My profile" }),
  ).toHaveAttribute("href", "/people/morgan%40sentry.io");
  await expect(popover.getByRole("button", { name: "Log out" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  const signOutRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/auth/sign-out") &&
      request.method() === "POST",
  );
  await page.getByRole("button", { name: "Log out" }).click();
  await signOutRequest;
});

test("inspects and copies an advisor transcript", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  await page.goto(
    `${baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
  );

  await expect(
    page.getByRole("heading", { name: "Dashboard QA edge cases" }),
  ).toBeVisible();
  const subagentRow = page
    .getByRole("button", { name: "Open advisor transcript" })
    .first();
  await expect(subagentRow).toHaveCSS("cursor", "pointer");
  await subagentRow.click();

  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "advisor" })).toBeVisible();
  await expect(drawer.getByText("Conversation ID")).toBeVisible();
  const copy = drawer.getByRole("button", { name: "Copy as Markdown" });
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(drawer.getByRole("button", { name: "Copied" })).toBeVisible();
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown).toContain("# advisor");
  expect(markdown).toContain("Review the dashboard plan before editing.");
  expect(markdown).toContain(
    "Actor identity email is a reasonable profile key",
  );

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Copied" })).toBeVisible();
});
