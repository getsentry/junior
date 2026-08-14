import { expect, test } from "@playwright/test";
import {
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
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    requests += 1;
    await route.fallback();
  });

  await page.goto(server.baseURL);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  expect(requests).toBe(1);

  // Fresh feeds must not refetch on focus. Fail if another list fetch starts.
  const extraFeedFetch = page
    .waitForRequest(
      (request) => {
        if (request.method() !== "GET") return false;
        return new URL(request.url()).pathname === "/api/conversations";
      },
      { timeout: 500 },
    )
    .then(() => true)
    .catch(() => false);

  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });

  expect(await extraFeedFetch).toBe(false);
  expect(requests).toBe(1);
});

test("keeps cached conversation and draft available through reconnect", async ({
  context,
  page,
}) => {
  const conversationId = "slack:CQA123:1770003600.000200";
  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const heading = page.getByRole("heading", {
    name: "Investigate checkout latency",
  });
  await expect(heading).toBeVisible();

  await context.setOffline(true);
  await expect(
    page.getByText("You’re offline. Drafts stay on this device."),
  ).toBeVisible();
  await expect(heading).toBeVisible();

  const composer = page.getByLabel("Continue this conversation");
  await composer.fill("Keep this draft through reconnect");
  await expect(
    page.getByText("Connect to send. Your draft is saved."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await context.setOffline(false);
  await expect(
    page.getByText("You’re offline. Drafts stay on this device."),
  ).toBeHidden();
  await expect(composer).toHaveValue("Keep this draft through reconnect");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("opens a conversation in the built dashboard", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });

  await page.goto(server.baseURL);

  await expect(page.getByRole("link", { name: "Junior home" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  const publicConversationLink = page.getByRole("link", {
    name: /Checkout latency triage/,
  });
  const privateConversationLink = page.getByRole("link", {
    name: /Direct Message/,
  });
  await expect(
    privateConversationLink.getByLabel("Private conversation"),
  ).toBeVisible();
  await expect(
    publicConversationLink.getByLabel("Private conversation"),
  ).toHaveCount(0);
  await publicConversationLink.click();
  await expect(page).toHaveURL(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Public conversation");
  await expect(page.getByRole("note")).toContainText("Public");

  const costMetric = page
    .getByRole("main")
    .locator('span[tabindex="0"]')
    .filter({ hasText: /^\$0\.03$/ });
  await expect(costMetric).toHaveCount(1);
  await costMetric.focus();
  const costTooltip = page.getByRole("tooltip");
  await expect(costTooltip).toBeVisible();
  const tooltipId = await costTooltip.getAttribute("id");
  expect(tooltipId).toBeTruthy();
  await expect(costMetric).toHaveAttribute("aria-describedby", tooltipId!);
  await page.keyboard.press("Escape");
  await expect(costTooltip).toBeHidden();

  await expect(
    page.getByRole("link", { name: "Conversations" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Plugins" })).toHaveCount(0);

  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:DQA123:1770007200.000300")}`,
  );
  await expect(page.getByRole("note")).toContainText("Private conversation");
  await expect(page.getByRole("note")).toContainText("Private");
});

test("starts and continues conversations from the dashboard", async ({
  page,
}) => {
  const createdConversationId = "local:web:created";
  const createRequests: Array<{
    idempotencyKey: string;
    message: string;
    visibility?: "private" | "public";
  }> = [];
  const continueRequests: Array<{ idempotencyKey: string; message: string }> =
    [];
  let releaseFirstContinue: (() => void) | undefined;
  const firstContinueHeld = new Promise<void>((resolve) => {
    releaseFirstContinue = resolve;
  });
  let releaseFirstCreate: (() => void) | undefined;
  const firstCreateHeld = new Promise<void>((resolve) => {
    releaseFirstCreate = resolve;
  });
  let holdDetailRefresh = false;
  let releaseDetailRefresh: (() => void) | undefined;
  const detailRefreshHeld = new Promise<void>((resolve) => {
    releaseDetailRefresh = resolve;
  });
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    createRequests.push(route.request().postDataJSON());
    if (createRequests.length === 1) {
      // Hold the first create so we can prove send stays locked mid-flight.
      await firstCreateHeld;
      await route.fulfill({
        json: { error: "temporary failure" },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      json: {
        conversationId: createdConversationId,
        messageId: "created-message",
        status: "accepted",
      },
    });
  });
  await page.route("**/api/conversations/*/messages", async (route) => {
    const body = route.request().postDataJSON() as {
      idempotencyKey: string;
      message: string;
    };
    continueRequests.push(body);
    // Hold every accept until release so concurrent queue rows stay visible.
    await firstContinueHeld;
    if (
      body.message === "Continue in Junior" &&
      continueRequests.filter((item) => item.message === "Continue in Junior")
        .length === 1
    ) {
      await route.fulfill({
        json: { error: "temporary failure" },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      json: {
        conversationId: "slack:CQA123:1770000000.000100",
        messageId: `continued-message-${continueRequests.length}`,
        status: "accepted",
      },
    });
  });

  await page.goto(server.baseURL);
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "New conversation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Private" }).click();
  const startComposer = page.getByLabel("Start a conversation");
  await startComposer.fill("Start from the dashboard");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => createRequests.length).toBe(1);
  // Create restore keeps send locked while the first accept is open so a later
  // submit cannot race the failed-draft restore.
  await expect(
    page.getByRole("button", { name: "Sending message" }),
  ).toBeDisabled();
  await startComposer.evaluate((element) => {
    element.closest("form")?.requestSubmit();
  });
  expect(createRequests).toHaveLength(1);
  releaseFirstCreate?.();
  await expect(
    page.getByText("Could not create the conversation. Try again."),
  ).toBeVisible();
  // New roots have no mailbox outbox, so a failed create restores the draft and
  // keeps the same idempotency key for a safe retry.
  await expect(startComposer).toHaveValue("Start from the dashboard");
  const failedCreateKey = createRequests[0]?.idempotencyKey;
  expect(createRequests[0]?.message).toBe("Start from the dashboard");
  expect(createRequests[0]?.visibility).toBe("private");
  expect(failedCreateKey).toBeTruthy();

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(
    `${server.baseURL}/conversations/${encodeURIComponent(createdConversationId)}`,
  );
  expect(createRequests).toHaveLength(2);
  expect(createRequests[1]?.idempotencyKey).toBe(failedCreateKey);
  expect(createRequests[1]?.message).toBe("Start from the dashboard");
  expect(createRequests[1]?.visibility).toBe("private");

  const slackConversationId = "slack:CQA123:1770000000.000100";
  await page.route(
    `**/api/conversations/${encodeURIComponent(slackConversationId)}`,
    async (route) => {
      if (holdDetailRefresh) await detailRefreshHeld;
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), isParticipant: true },
      });
    },
  );
  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent(slackConversationId)}`,
  );
  await expect(
    page.getByText(
      "This reply stays in Junior. It will not be posted to Slack.",
    ),
  ).toHaveCount(0);
  const composer = page.getByLabel("Continue this conversation");
  await composer.fill("Continue in Junior");
  await page.getByRole("button", { name: "Send" }).click();
  const pending = page.getByLabel("Pending messages");
  await expect(pending.getByText("Continue in Junior")).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect.poll(() => continueRequests.length).toBe(1);
  // Distinct messages can queue while an earlier accept is still open.
  await composer.fill("Second queued message");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(pending.getByText("Second queued message")).toBeVisible();
  await expect.poll(() => continueRequests.length).toBe(2);
  // Empty-composer double submit must not mint another request.
  await composer.evaluate((element) => {
    element.closest("form")?.requestSubmit();
  });
  expect(continueRequests).toHaveLength(2);
  releaseFirstContinue?.();
  await expect(pending.getByText("Could not send.")).toBeVisible();
  await expect(composer).toHaveValue("");
  const failedIdempotencyKey = continueRequests[0]?.idempotencyKey;
  expect(continueRequests[0]?.message).toBe("Continue in Junior");
  expect(failedIdempotencyKey).toBeTruthy();

  holdDetailRefresh = true;
  await pending.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => continueRequests.length).toBe(3);
  expect(continueRequests[2]?.idempotencyKey).toBe(failedIdempotencyKey);
  // The accepted message stays out of the composer before background transcript
  // refreshes finish. A slow read must not make the send look like a UI reload.
  await expect(composer).toHaveValue("");
  await expect(pending.getByText("Continue in Junior")).toBeHidden();
  releaseDetailRefresh?.();

  await page.reload();
  await expect(page.getByLabel("Continue this conversation")).toHaveValue("");
});

test("collapses long pending message stacks", async ({ page }) => {
  const conversationId = "slack:CQA123:1770003600.000200";
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );

  const pending = page.getByLabel("Pending messages");
  await expect(pending).toBeVisible();
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeVisible();
  await expect(
    pending.getByText(
      "Keep the reply in Junior. I will paste the dashboard link next.",
    ),
  ).toBeVisible();
  const expand = pending.getByRole("button", {
    name: "3 more queued messages",
  });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("Third queued message.")).toBeHidden();

  await expand.click();
  await expect(
    pending.getByRole("button", { name: "Show fewer queued messages" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(pending.getByText("Third queued message.")).toBeVisible();
  await expect(pending.getByText("Fifth queued message.")).toBeVisible();

  await pending
    .getByRole("button", { name: "Show fewer queued messages" })
    .click();
  await expect(
    pending.getByRole("button", { name: "3 more queued messages" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("Third queued message.")).toBeHidden();
});

test("opens and closes a conversation in the mobile workspace", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route("**/api/conversations/*/messages", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "slack:CQA123:1770003600.000200",
        messageId: "mobile-message",
        status: "accepted",
      },
    });
  });
  await page.goto(`${server.baseURL}/conversations`);
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  const navigationTrigger = page.getByRole("button", {
    name: "Open navigation",
  });
  await expect(navigationTrigger).toBeVisible();
  await expect(page.getByLabel("Junior home")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open profile menu for Dashboard User" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Conversations", exact: true }),
  ).toBeHidden();
  await navigationTrigger.click();
  await expect(page.getByText(/^junior version /)).toBeVisible();
  const closeNavigation = page.getByRole("button", {
    name: "Close navigation",
  });
  await expect(closeNavigation).toBeVisible();
  await closeNavigation.click();

  // Participant fixture so the compact mobile composer is present.
  await page
    .getByRole("link", { name: /Investigate checkout latency/ })
    .click();
  await expect(page).toHaveURL(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();

  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("1.9k tokens")).toBeHidden();
  await expect(page.getByRole("button", { name: "Archive" })).toBeHidden();
  await expect(page.getByPlaceholder("Search transcript…")).toBeHidden();
  await expect(
    page.getByRole("group", { name: "Transcript view" }),
  ).toBeVisible();
  await expect(page.getByRole("note")).toBeHidden();
  await page.getByRole("button", { name: "Search transcript" }).focus();
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  const pending = page.getByLabel("Pending messages");
  await expect(pending).toBeVisible();
  // Mobile collapsed control owns the total count (no separate cancel bar).
  const expand = pending.getByRole("button", { name: "5 queued messages" });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("5 queued messages")).toHaveCount(1);
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeHidden();

  await expand.click();
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeVisible();
  await expect(
    pending.getByRole("button", { name: "Show fewer queued messages" }),
  ).toHaveAttribute("aria-expanded", "true");

  const composer = page.getByPlaceholder("Message Junior…");
  await expect(composer).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();

  const shell = page.locator("main").first();
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 140 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-height"),
      ),
    )
    .toBe("520px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("140px");

  // Offset can change from a visualViewport scroll without a resize.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 180 },
    });
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("180px");

  await composer.blur();
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await composer.focus();
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  // Keyboard resize keeps the latest message above the focused composer.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 480,
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  await composer.fill("Keep the mobile composer ready");
  await composer.press("Enter");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Search transcript" }).click();
  await expect(page.getByPlaceholder("Search transcript…")).toBeVisible();
  await page.getByRole("button", { name: "Event log" }).click();
  await page.getByRole("button", { name: "Hide search" }).click();
  await expect(page.getByPlaceholder("Search transcript…")).toBeHidden();
  await expect(
    page.getByRole("group", { name: "Transcript view" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Your conversations" }).click();
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
});

test("loads earlier transcript events from the mock history cursor", async ({
  page,
}) => {
  // Deeper history/cursor contracts live in dashboard-mock-routes + transcript
  // bottom-pinning unit coverage. Keep one browser smoke on the mock surface.
  const conversationId = "slack:CQA456:1770021600.000600";
  await page.goto(
    `${server.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );

  await expect(
    page.getByRole("heading", { name: "Package release and self-update" }),
  ).toBeVisible();
  await expect(page.getByText("Released the package.")).toBeVisible();

  const loadEarlier = page.getByRole("button", {
    name: "Load earlier events",
  });
  await expect(loadEarlier).toBeVisible();
  await loadEarlier.click();
  await expect(loadEarlier).toHaveCount(0);
  await expect(page.getByText("Released the package.")).toBeVisible();
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

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
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
  expect(
    await transcript.evaluate(
      (element) =>
        element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    ),
  ).toBe(true);
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
  await trigger.click();

  const popover = page.locator("#profile-popover");
  await expect(popover.getByText("dev@example.com")).toBeVisible();
  await expect(
    popover.getByRole("link", { name: "My profile" }),
  ).toHaveAttribute("href", "/people/dev%40example.com");
  await expect(
    popover.getByRole("link", { name: "API tokens" }),
  ).toHaveAttribute("href", "/settings/api-tokens");
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
  // Subagents live inside the collapsed activity chip between turns.
  const activityChip = page
    .locator("details")
    .filter({ hasText: /\d+ events?/ })
    .first();
  await expect(activityChip).toBeVisible();
  await activityChip.locator("> summary").click();
  await page
    .getByRole("button", { name: "Open advisor transcript" })
    .first()
    .click();

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
  const selectedConversation = page.getByRole("link", {
    name: /Investigate checkout latency/,
  });
  await selectedConversation.click();
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
  const emptyView = page.getByText("No conversations match this view.");
  const archiveRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/archive"),
  );
  await archiveButton.click();
  // Optimistic pending keeps the row while the 1s archive mock is in flight.
  await expect(emptyView).toHaveCount(0);
  const archiveRequest = await archiveRequestPromise;
  expect(archiveRequest.postDataJSON()).toMatchObject({ archived: true });
  expect(page.url()).toBe(currentUrl);

  const undoNotice = page.getByRole("status").filter({
    hasText: "Conversation archived",
  });
  await expect(undoNotice).toBeVisible();
  await expect(undoNotice).toContainText("Dashboard QA edge cases");

  // Undo immediately so the 6s expiry cannot race this path. Dedicated clock
  // tests cover expiry; keep this test on archive/restore behavior only.
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
  await expect(
    page.getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    }),
  ).toHaveText("Restoring…");
  const restoreRequest = await restoreRequestPromise;
  expect(restoreRequest.postDataJSON()).toMatchObject({ archived: false });
  await expect(undoNotice).toHaveCount(0);
  await expect(conversationLink).toBeVisible();
  expect(page.url()).toBe(currentUrl);
});

test("expires the archive undo notice", async ({ page }) => {
  await page.clock.install();
  await page.route("**/api/conversations/*/archive", async (route) => {
    await route.fulfill({ json: { archived: true } });
  });
  await page.goto(server.baseURL);

  const conversationLink = page.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  await conversationLink.hover();
  await page
    .getByRole("button", { name: "Archive Dashboard QA edge cases" })
    .click();

  const undo = page.getByRole("button", {
    name: "Undo archive for Dashboard QA edge cases",
  });
  await expect(undo).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(undo).toBeVisible();
  await page.clock.fastForward(1_000);
  await expect(undo).toHaveCount(0);
});

test("resets the archive undo timer when archiving another conversation", async ({
  page,
}) => {
  await page.clock.install();
  await page.route("**/api/conversations/*/archive", async (route) => {
    await route.fulfill({ json: { archived: true } });
  });
  await page.goto(server.baseURL);

  await page.getByRole("link", { name: /Dashboard QA edge cases/ }).hover();
  await page
    .getByRole("button", { name: "Archive Dashboard QA edge cases" })
    .click();
  const firstUndo = page.getByRole("button", {
    name: "Undo archive for Dashboard QA edge cases",
  });
  await expect(firstUndo).toBeVisible();

  // Burn most of the first notice's timer, then archive a second conversation.
  await page.clock.fastForward(5_000);
  await page.getByRole("link", { name: /Checkout latency triage/ }).hover();
  await page
    .getByRole("button", { name: "Archive Checkout latency triage" })
    .click();

  const secondUndo = page.getByRole("button", {
    name: "Undo archive for Checkout latency triage",
  });
  await expect(secondUndo).toBeVisible();
  await expect(firstUndo).toHaveCount(0);

  // A reused first-notice timer would dismiss here; a reset timer must remain.
  await page.clock.fastForward(2_000);
  await expect(secondUndo).toBeVisible();
  await page.clock.fastForward(4_000);
  await expect(secondUndo).toHaveCount(0);
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
  const archiveError = page.getByRole("alert").filter({
    hasText: "Could not archive",
  });
  await expect(archiveError).toBeVisible();
  await expect(archiveError).toContainText("Dashboard QA edge cases");
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

  const archiveError = page.getByRole("alert").filter({
    hasText: "Could not archive",
  });
  await expect(archiveError).toBeVisible();
  await expect(archiveError).toContainText("Checkout latency triage");
  await expect(undo).toBeVisible();
});
