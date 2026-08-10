import { expect, test } from "@playwright/test";
import type {
  ConversationDetailReport,
  ConversationEventPage,
} from "@sentry/junior/api/schema";
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

test("reuses the fresh conversation feed after window focus", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/conversations?*", async (route) => {
    requests += 1;
    await route.fallback();
  });

  await page.goto(server.baseURL);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  expect(requests).toBe(1);

  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);

  expect(requests).toBe(1);
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
  await expect(page.getByRole("note")).toContainText(
    "Public conversation. Anyone in this workspace can see this transcript.",
  );

  const costMetric = page
    .getByRole("main")
    .locator('span[tabindex="0"]')
    .filter({ hasText: /^\$0\.03$/ });
  await expect(costMetric).toHaveCount(1);
  await costMetric.hover();
  const costTooltip = page.getByRole("tooltip");
  await expect(costTooltip).toBeVisible();
  const tooltipBounds = await costTooltip.boundingBox();
  expect(tooltipBounds).not.toBeNull();
  if (!tooltipBounds) throw new Error("Expected cost tooltip bounds");
  expect(tooltipBounds.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBounds.y).toBeGreaterThanOrEqual(0);
  expect(tooltipBounds.x + tooltipBounds.width).toBeLessThanOrEqual(1600);
  expect(tooltipBounds.y + tooltipBounds.height).toBeLessThanOrEqual(900);

  const costValue = costTooltip.getByText("$0.0332", { exact: true });
  const valueBounds = await costValue.boundingBox();
  expect(valueBounds).not.toBeNull();
  if (!valueBounds) throw new Error("Expected cost value bounds");
  await page.mouse.move(
    valueBounds.x + 2,
    valueBounds.y + valueBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    tooltipBounds.x + tooltipBounds.width + 40,
    valueBounds.y + valueBounds.height / 2,
    { steps: 8 },
  );
  await page.waitForTimeout(200);
  await expect(costTooltip).toBeVisible();
  await page.mouse.up();
  await page.waitForTimeout(200);
  await expect(costTooltip).toBeVisible();
  expect(
    await page.evaluate(() => window.getSelection()?.toString()),
  ).toContain("$0.0332");
  await page.keyboard.press("Escape");
  await expect(costTooltip).toBeHidden();

  await costMetric.focus();
  await expect(costTooltip).toBeVisible();
  const tooltipId = await costTooltip.getAttribute("id");
  expect(tooltipId).toBeTruthy();
  await expect(costMetric).toHaveAttribute("aria-describedby", tooltipId!);
  await page.keyboard.press("Escape");
  await expect(costTooltip).toBeHidden();

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

  await expect(
    page.getByRole("link", { name: "Conversations" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Plugins" })).toHaveCount(0);
  expect(await containerBounds()).toEqual(headerBounds);

  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:DQA123:1770007200.000300")}`,
  );
  await expect(page.getByRole("note")).toContainText(
    "Private conversation. Only members of this conversation can see this transcript.",
  );
  expect(browserErrors).toEqual([]);
});

test("positions a long cost tooltip clear of its metric", async ({ page }) => {
  const conversationId = "slack:CQA123:1770003600.000200";
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}`,
    async (route) => {
      const response = await route.fetch();
      const detail = (await response.json()) as ConversationDetailReport;
      await route.fulfill({
        response,
        json: {
          ...detail,
          modelUsage: [
            {
              modelId: "openai/gpt-5.6-sol",
              usage: {
                cost: {
                  cacheRead: 0.004,
                  cacheWrite: 0.005,
                  input: 0.01,
                  output: 0.021,
                  total: 0.04,
                },
              },
            },
            {
              modelId: "xai/grok-4.5",
              usage: { cost: { input: 0.0004, output: 0.0006, total: 0.001 } },
            },
          ],
        },
      });
    },
  );
  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );

  // Active conversation cost is provisional (`$0.04+`) until the turn settles.
  const cost = page
    .locator('span[tabindex="0"]')
    .filter({ hasText: /^\$0\.04\+?$/ })
    .first();
  await expect(cost).toBeVisible();
  await cost.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();

  const costBounds = await cost.boundingBox();
  const tooltipBounds = await tooltip.boundingBox();
  expect(costBounds).not.toBeNull();
  expect(tooltipBounds).not.toBeNull();
  const tooltipIsAbove =
    tooltipBounds!.y + tooltipBounds!.height < costBounds!.y;
  const tooltipIsBelow = tooltipBounds!.y > costBounds!.y + costBounds!.height;
  expect(tooltipIsAbove || tooltipIsBelow).toBe(true);

  const columns = tooltip.locator(":scope > span > span");
  await expect(columns).toHaveCount(2);
  const auxiliary = columns.nth(1);
  const headingBounds = await auxiliary
    .getByText("Auxiliary", { exact: true })
    .boundingBox();
  const totalBounds = await auxiliary
    .getByText("total", { exact: true })
    .boundingBox();
  expect(headingBounds).not.toBeNull();
  expect(totalBounds).not.toBeNull();
  expect(totalBounds!.y - headingBounds!.y).toBeLessThan(40);
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

test("opens metric tooltips on touch", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  });
  const page = await context.newPage();
  await mockDashboardApis(page);

  try {
    await page.goto(
      `${server.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
    );
    await expect(
      page.getByRole("heading", { name: "Checkout latency triage" }),
    ).toBeVisible();

    const costMetric = page
      .locator('span[tabindex="0"]')
      .filter({ hasText: /^\$0\.03$/, visible: true });
    await expect(costMetric).toHaveCount(1);

    await costMetric.tap();
    await expect(page.getByRole("tooltip")).toBeVisible();

    // Close outside the metric/tooltip. Heading can sit under an above-placed tip.
    await page.getByRole("searchbox", { name: "Search transcript" }).tap();
    await expect(page.getByRole("tooltip")).toBeHidden();

    await costMetric.tap();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search transcript" }).tap();
    await expect(page.getByRole("tooltip")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("loads earlier transcript events without dropping the current page", async ({
  page,
}) => {
  const conversationId = "slack:CQA456:1770021600.000600";
  const detailPath = `/api/conversations/${encodeURIComponent(conversationId)}`;
  let detailReads = 0;
  let historyReads = 0;
  const earlierEvents: ConversationEventPage["events"] = [
    {
      seq: 0,
      createdAt: "2026-06-12T00:00:00.000Z",
      data: {
        type: "message",
        messageId: "release-earlier-user",
        role: "user",
        text: "Prepare the release and include the complete earlier context.",
      },
    },
    {
      seq: 1,
      createdAt: "2026-06-12T00:00:01.000Z",
      data: {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "release-bash-earlier",
            name: "bash",
            status: "running",
          },
        ],
      },
    },
  ];
  const liveReasoningEvent: ConversationDetailReport["events"][number] = {
    seq: 17,
    createdAt: "2026-06-12T00:00:17.000Z",
    data: {
      type: "tool_calls",
      calls: [
        {
          toolCallId: "release-live-check",
          name: "bash",
          status: "running",
        },
      ],
      assistant: {
        parts: [
          {
            type: "reasoning",
            text: "Wait for the live release check to finish.",
          },
          {
            type: "tool_call",
            toolCallId: "release-live-check",
          },
        ],
      },
    },
  };
  await page.route(`**${detailPath}`, async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as ConversationDetailReport;
    detailReads += 1;
    await route.fulfill({
      response,
      json:
        detailReads === 1
          ? {
              ...detail,
              events: [...detail.events.slice(1), liveReasoningEvent],
              status: "active",
            }
          : {
              ...detail,
              events: [
                ...detail.events.slice(1),
                liveReasoningEvent,
                {
                  seq: 18,
                  createdAt: "2026-06-12T00:00:18.000Z",
                  data: {
                    type: "tool_calls",
                    calls: [
                      {
                        toolCallId: "release-live-status",
                        name: "bash",
                        status: "running",
                      },
                    ],
                    assistant: {
                      parts: [
                        {
                          type: "tool_call",
                          toolCallId: "release-live-status",
                        },
                      ],
                    },
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
    const response = await route.fetch();
    const page = (await response.json()) as ConversationEventPage;
    await route.fulfill({
      response,
      json: {
        ...page,
        events: earlierEvents,
        previousCursor: undefined,
      },
    });
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

  const toolRun = page.locator("details").filter({ hasText: /tool calls/ });
  await toolRun.locator("summary").click();
  await expect(toolRun).toHaveAttribute("open", "");
  const liveReasoning = page
    .locator("details")
    .filter({ hasText: "Wait for the live release check to finish." });
  await liveReasoning.locator("summary").click();
  await expect(liveReasoning).toHaveAttribute("open", "");

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
  await expect(liveReasoning).toHaveAttribute("open", "");

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
  await expect(trigger).toContainText("7d$0.07");
  await expect(trigger).toContainText("30d$0.07");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.hover();

  const popover = page.locator("#profile-popover");
  await expect(popover.getByText("dev@example.com")).toBeVisible();
  await expect(
    popover.getByRole("link", { name: "My profile" }),
  ).toHaveAttribute("href", "/people/dev%40example.com");
  await expect(popover.getByRole("button", { name: "Log out" })).toBeVisible();
  await popover.getByRole("link", { name: "My profile" }).hover();
  await page.waitForTimeout(200);
  await expect(popover).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.mouse.move(0, 0);
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
      name: "Open getsentry/junior#1081",
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
  const initialTime = Date.now();
  await page.setViewportSize({ height: 900, width: 1600 });
  let archived = false;
  await page.route(/\/api\/conversations(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    await route.fulfill({
      response,
      json: {
        ...feed,
        conversations: feed.conversations.filter(
          (conversation: { displayTitle: string }) =>
            !archived ||
            conversation.displayTitle !== "Dashboard QA edge cases",
        ),
      },
    });
  });
  await page.route("**/api/conversations/*/archive", async (route) => {
    const request = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    archived = request.archived;
    await route.fulfill({ json: { archived } });
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
  await page
    .getByRole("searchbox", { name: "Search your conversations" })
    .fill("Dashboard QA edge cases");
  await conversationLink.hover();

  const currentUrl = page.url();
  const archiveRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/archive"),
  );
  await archiveButton.click();
  const emptyView = page.getByText("No conversations match this view.");
  await expect(emptyView).toHaveCount(0);
  const archiveFocusRefetch = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/api\/conversations(?:\?.*)?$/.test(response.url()),
  );
  await page.clock.setFixedTime(new Date(initialTime + 31_000));
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await archiveFocusRefetch;
  await expect(conversationLink).toHaveCount(0);
  await page.waitForTimeout(220);
  await expect(emptyView).toBeVisible();
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
  await expect(conversationLink).toBeVisible();
  const restoreFocusRefetch = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/api\/conversations(?:\?.*)?$/.test(response.url()),
  );
  await page.clock.setFixedTime(new Date(initialTime + 62_000));
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await restoreFocusRefetch;
  await expect(conversationLink).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    }),
  ).toHaveText("Restoring…");
  const restoreRequest = await restoreRequestPromise;

  expect(restoreRequest.postDataJSON()).toMatchObject({ archived: false });
  await expect(
    page.getByRole("status").filter({
      hasText: "Dashboard QA edge cases archived",
    }),
  ).toHaveCount(0);
  expect(page.url()).toBe(currentUrl);
});

test("shows archive failures after the row returns", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.route("**/api/conversations/*/archive", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: { error: "Archive failed" },
      status: 500,
    });
  });
  await page.goto(server.baseURL);

  const conversationLink = page.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  await conversationLink.hover();
  await page
    .getByRole("button", { name: "Archive Dashboard QA edge cases" })
    .click();

  await expect(conversationLink).toBeVisible();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Could not archive Dashboard QA edge cases.",
    }),
  ).toBeVisible();
});

test("keeps undo available when another archive fails", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  let archiveRequests = 0;
  await page.route("**/api/conversations/*/archive", async (route) => {
    archiveRequests += 1;
    if (archiveRequests === 1) {
      await route.fulfill({ json: { archived: true } });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: { error: "Archive failed" },
      status: 500,
    });
  });
  await page.goto(server.baseURL);

  const firstConversation = page.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  await firstConversation.hover();
  await page
    .getByRole("button", { name: "Archive Dashboard QA edge cases" })
    .click();
  const undo = page.getByRole("button", {
    name: "Undo archive for Dashboard QA edge cases",
  });
  await expect(undo).toBeVisible();

  const secondConversation = page.getByRole("link", {
    name: /Checkout latency triage/,
  });
  await secondConversation.hover();
  await page
    .getByRole("button", { name: "Archive Checkout latency triage" })
    .click();

  await expect(
    page.getByRole("alert").filter({
      hasText: "Could not archive Checkout latency triage.",
    }),
  ).toBeVisible();
  await expect(undo).toBeVisible();
});
