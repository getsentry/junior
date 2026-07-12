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
    allowedEmails: ["dashboard-user@sentry.io"],
    auth: {
      async getSession() {
        return {
          user: {
            email: "dashboard-user@sentry.io",
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
  await expect(page.getByText("0ms runtime")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
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
  await expect(popover.getByText("dashboard-user@sentry.io")).toBeVisible();
  await expect(
    popover.getByRole("link", { name: "My profile" }),
  ).toHaveAttribute("href", "/people/dashboard-user%40sentry.io");
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
