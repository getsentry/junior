import { expect, test } from "@playwright/test";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import {
  collectBrowserErrors,
  type DashboardE2eServer,
  mockDashboardApis,
  startDashboardE2eServer,
} from "./harness";

let server: DashboardE2eServer;

test.beforeAll(async () => {
  server = await startDashboardE2eServer();
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  await mockDashboardApis(page);
});

test("opens a conversation in the built dashboard", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  const browserErrors = collectBrowserErrors(page);

  await page.goto(server.baseURL);

  await expect(page.getByRole("link", { name: "Junior home" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Checkout latency triage/ }).click();
  await expect(page).toHaveURL(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
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
  expect(await containerBounds()).toEqual(headerBounds);
  expect(browserErrors).toEqual([]);
});

test("opens and closes a conversation in the mobile workspace", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${server.baseURL}/conversations`);
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();

  await page.getByRole("link", { name: /Checkout latency triage/ }).click();
  await expect(page).toHaveURL(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Your conversations" }).click();
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
});

test("loads earlier transcript events without dropping the current page", async ({
  page,
}) => {
  const conversationId = "slack:CQA456:1770021600.000600";
  const detailPath = `/api/conversations/${encodeURIComponent(conversationId)}`;
  let detailReads = 0;
  let historyReads = 0;
  await page.route(`**${detailPath}`, async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as ConversationDetailReport;
    detailReads += 1;
    await route.fulfill({
      response,
      json:
        detailReads === 1
          ? { ...detail, status: "active" }
          : {
              ...detail,
              events: [
                ...detail.events.slice(1),
                {
                  seq: 17,
                  createdAt: "2026-06-12T00:00:17.000Z",
                  data: {
                    type: "message",
                    messageId: "release-live-update",
                    role: "assistant",
                    text: "The release verification is still running.",
                  },
                },
              ],
              previousCursor: `mock:before:${encodeURIComponent(conversationId)}:2`,
              status: "active",
            },
    });
  });
  await page.route(`**${detailPath}/events?*`, async (route) => {
    historyReads += 1;
    if (historyReads === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    await route.continue();
  });
  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );

  await expect(
    page.getByRole("heading", { name: "Package release and self-update" }),
  ).toBeVisible();
  const currentEvent = page
    .locator("p")
    .filter({ hasText: "Released the package." })
    .filter({ hasText: "Opened the update pull request." })
    .filter({ hasText: "Deployment is ready." });
  await expect(currentEvent).toBeVisible();
  await expect(currentEvent.locator("br")).toHaveCount(2);

  const toolRun = page.locator("details").filter({ hasText: /12 tool calls/ });
  await toolRun.locator("summary").click();
  await expect(toolRun).toHaveAttribute("open", "");

  const transcript = page.locator('[aria-label="Conversation transcript"]');
  const loadEarlier = page.getByRole("button", {
    name: "Load earlier events",
  });
  await loadEarlier.scrollIntoViewIfNeeded();
  const before = await transcript.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));

  await loadEarlier.click();
  await expect.poll(() => detailReads).toBeGreaterThan(1);

  await expect(
    page.getByText(
      "Prepare the release and include the complete earlier context.",
    ),
  ).toBeVisible();
  await expect(currentEvent).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load earlier events" }),
  ).toHaveCount(0);
  await expect(toolRun).toHaveAttribute("open", "");

  const after = await transcript.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(after.scrollTop - before.scrollTop).toBe(
    after.scrollHeight - before.scrollHeight,
  );
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
    isParticipant: true,
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
        eventHistory: { status: "available" },
        isParticipant: true,
        events: Array.from({ length: 60 }, (_, index) => ({
          createdAt: new Date(
            Date.parse(generatedAt) + index * 1_000,
          ).toISOString(),
          data: {
            type: "message",
            messageId: `message-${index + 1}`,
            role: index % 2 === 0 ? "user" : "assistant",
            text: `Transcript message ${index + 1} with enough content to occupy a visible row.`,
          },
          seq: index,
        })),
      },
    });
  });

  await page.goto(`${server.baseURL}/conversations/long-0`);
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
  await page.goto(server.baseURL);

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
  const childConversationId = "junior:internal:dashboard-qa:advisor-plan";
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: server.baseURL,
  });
  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
  );

  await expect(
    page.getByRole("heading", { name: "Dashboard QA edge cases" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Open pull request getsentry/junior #1081: Show conversation pull requests",
    }),
  ).toHaveAttribute("href", "https://github.com/getsentry/junior/pull/1081");
  const subagentRow = page
    .getByRole("button", { name: "Open advisor transcript" })
    .first();
  await subagentRow.click();

  const drawer = page.getByRole("dialog");
  await expect(
    drawer.getByRole("heading", { name: "Advisor review" }),
  ).toBeVisible();
  await expect(
    drawer.getByText(childConversationId, { exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("link", { name: "Open conversation" }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent(childConversationId)}`,
  );
  const copy = drawer.getByRole("button", { name: "Copy as Markdown" });
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(drawer.getByRole("button", { name: "Copied" })).toBeVisible();
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown).toContain("# Advisor review");
  expect(markdown).toContain("Review the dashboard plan before editing.");
  expect(markdown).toContain("Review complete; no blocking issues found.");

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(drawer).toBeVisible();
});

test("archives and restores a conversation from the sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.route("**/api/conversations/*/archive", async (route) => {
    await route.fulfill({ json: { archived: true } });
  });
  await page.goto(server.baseURL);
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();

  const conversationLink = page.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  const archiveButton = page.getByRole("button", {
    name: "Archive Dashboard QA edge cases",
  });
  await conversationLink.hover();

  const currentUrl = page.url();
  const archiveRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/archive"),
  );
  await archiveButton.click();
  const archiveRequest = await archiveRequestPromise;

  expect(archiveRequest.postDataJSON()).toMatchObject({ archived: true });
  expect(page.url()).toBe(currentUrl);
  await expect(
    page.getByRole("status").filter({
      hasText: "Dashboard QA edge cases archived",
    }),
  ).toBeVisible();

  const restoreRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/archive"),
  );
  await page
    .getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    })
    .click();
  const restoreRequest = await restoreRequestPromise;

  expect(restoreRequest.postDataJSON()).toMatchObject({ archived: false });
  await expect(
    page.getByRole("status").filter({
      hasText: "Dashboard QA edge cases archived",
    }),
  ).toHaveCount(0);
  expect(page.url()).toBe(currentUrl);
});
