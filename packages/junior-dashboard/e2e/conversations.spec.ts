import { withRequestedMailbox } from "./harness";
import { expect, test } from "./test";
import { mobile, screenshot } from "./screenshot";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";

test("records loaded conversation views", async ({ page, dashboard }) => {
  let releaseFeed: (() => void) | undefined;
  const feedPending = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  await page.route("**/api/conversations", async (route) => {
    await feedPending;
    await route.fallback();
  });
  await page.goto(dashboard.baseURL, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading your conversations")).toBeAttached();
  await expect(page.getByText("No conversations match this view.")).toHaveCount(
    0,
  );
  releaseFeed?.();
  await expect(
    page.getByRole("heading", { name: "What do you need?", exact: true }),
  ).toBeVisible();
  await screenshot(page, "conversations");

  const composer = page.getByLabel("Start a conversation");
  await expect(composer).toBeFocused();
  await screenshot(page, "conversation-create-focused");

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    { waitUntil: "networkidle" },
  );
  await expect(
    page.getByRole("heading", {
      name: "Investigate checkout latency",
      exact: true,
    }),
  ).toBeVisible();
  const conversationList = page.getByRole("navigation", {
    name: "Your conversations",
  });
  const hideList = page.getByRole("button", { name: "Hide conversation list" });
  await expect(conversationList).toBeVisible();
  await expect(hideList).toHaveAttribute("aria-expanded", "true");
  await hideList.click();
  await expect(conversationList).toBeHidden();
  const showList = page.getByRole("button", { name: "Show conversation list" });
  await expect(showList).toHaveAttribute("aria-expanded", "false");
  await expect(showList).toBeFocused();

  await page.reload();
  await expect(showList).toBeVisible();
  await expect(conversationList).toBeHidden();
  await showList.press("Enter");
  await expect(conversationList).toBeVisible();
  await expect(hideList).toBeFocused();

  await page.reload();
  await expect(hideList).toBeVisible();
  await expect(conversationList).toBeVisible();

  const resizeList = page.getByRole("separator", {
    name: "Resize conversation list",
  });
  const listSize = async () =>
    Number(await resizeList.getAttribute("aria-valuenow"));
  const startSize = await listSize();
  await resizeList.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(listSize).toBeGreaterThan(startSize);
  const resizedSize = await listSize();
  await page.reload();
  await expect(conversationList).toBeVisible();
  // The saved width rounds to whole pixels.
  await expect.poll(listSize).toBeCloseTo(resizedSize, 0);

  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await expect(details).toBeVisible();
  const resizeDetails = page.getByRole("separator", {
    name: "Resize details panel",
  });
  // The separator reports the transcript share, which grows as details shrink.
  const transcriptSize = async () =>
    Number(await resizeDetails.getAttribute("aria-valuenow"));
  const startTranscriptSize = await transcriptSize();
  await resizeDetails.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(transcriptSize).toBeGreaterThan(startTranscriptSize);
  const resizedTranscriptSize = await transcriptSize();
  await page.reload();
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  await expect(details).toBeVisible();
  // The saved width rounds to whole pixels.
  await expect.poll(transcriptSize).toBeCloseTo(resizedTranscriptSize, 0);
  const usage = details.getByRole("button", { name: /^Usage/ });
  const modelBreakdown = details.getByRole("table", { name: "Model" });
  await expect(usage).toHaveAttribute("aria-expanded", "false");
  await expect(modelBreakdown).toBeHidden();
  await usage.click();
  await expect(modelBreakdown).toBeVisible();
  await usage.click();
  await expect(modelBreakdown).toBeHidden();
  // Turn context takes the details panel and gives it back on close.
  const contextAction = page.getByRole("button", { name: "View turn context" });
  await contextAction.scrollIntoViewIfNeeded();
  await contextAction.focus();
  await page.keyboard.press("Enter");
  const contextPanel = page.getByRole("complementary", {
    name: "Turn context",
    exact: true,
  });
  await expect(
    contextPanel.getByRole("heading", { name: "Recalled memories" }),
  ).toBeVisible();
  await expect(details).toBeHidden();
  await expect(contextAction).toHaveAttribute("aria-expanded", "true");
  await expect(contextAction).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(contextPanel).toBeHidden();
  await expect(details).toBeVisible();
  await expect(contextAction).toBeFocused();
  // A mouse open must not leave the tooltip open to take the first Escape.
  await contextAction.hover();
  await expect(
    page.getByText("View turn context", { exact: true }),
  ).toBeVisible();
  await contextAction.click();
  await expect(contextPanel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contextPanel).toBeHidden();
  await contextAction.click();
  await expect(contextPanel).toBeVisible();
  await contextAction.click();
  await expect(contextPanel).toBeHidden();
  await expect(details).toBeVisible();
  await details
    .getByRole("button", { name: "Close conversation details", exact: true })
    .click();
  await expect(details).toBeHidden();
  // Small screens show the same panel as a sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await contextAction.click();
  const contextSheet = page.getByRole("dialog", {
    name: "Turn context",
    exact: true,
  });
  await expect(
    contextSheet.getByRole("heading", { name: "Recalled memories" }),
  ).toBeVisible();
  await contextSheet
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(contextSheet).toBeHidden();
  await expect(contextAction).toBeFocused();
  await screenshot(page, "conversation-detail");

  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    { waitUntil: "networkidle" },
  );
  await expect(
    page.getByRole("heading", {
      name: "Dashboard QA edge cases",
      exact: true,
    }),
  ).toBeVisible();
  const inputImage = page.getByRole("img", { name: "input-chart.png" });
  await inputImage.scrollIntoViewIfNeeded();
  await expect(inputImage).toBeVisible();
  await inputImage.click();
  const inputPreview = page.getByRole("dialog", { name: "input-chart.png" });
  await expect(inputPreview).toBeVisible();
  // The sent image is not part of the response, so it has no pager.
  await expect(
    inputPreview.getByRole("button", { name: "Next image" }),
  ).toHaveCount(0);
  await inputPreview
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const image = page
    .locator('a[href*="/attachments/qa-chart-png"]')
    .filter({ has: page.locator('img[alt="chart.png"]') })
    .first();
  await image.waitFor({ state: "visible" });
  await image.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  await screenshot(page, "conversation-attachment");

  await image.click();
  const preview = page.getByRole("dialog", { name: "chart.png" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("1 of 2")).toBeVisible();
  await screenshot(page, "conversation-attachment-modal");
  // The preview pages through the images of one response.
  await preview.getByRole("button", { name: "Next image" }).click();
  const detailPreview = page.getByRole("dialog", { name: "chart-detail.png" });
  await expect(detailPreview.getByText("2 of 2")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(preview.getByText("1 of 2")).toBeVisible();

  // Touch readers swipe to page and dismiss, and pinch to zoom. Real touch
  // input checks that the frame keeps a gesture after a finger leaves it.
  await page.setViewportSize(mobile);
  const touch = await page.context().newCDPSession(page);
  const pinch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    points: { id: number; x: number; y: number }[],
  ) => touch.send("Input.dispatchTouchEvent", { touchPoints: points, type });
  const swipe = async (
    from: { x: number; y: number },
    dx: number,
    dy: number,
  ) => {
    await pinch("touchStart", [{ id: 1, ...from }]);
    for (const step of [0.25, 0.5, 0.75, 1]) {
      await pinch("touchMove", [
        { id: 1, x: from.x + dx * step, y: from.y + dy * step },
      ]);
    }
    await pinch("touchEnd", []);
  };
  await swipe({ x: 300, y: 450 }, -200, 0);
  await expect(detailPreview.getByText("2 of 2")).toBeVisible();
  await swipe({ x: 100, y: 450 }, 200, 0);
  await expect(preview.getByText("1 of 2")).toBeVisible();
  // A short swipe springs back, so the preview still pages.
  await swipe({ x: 200, y: 300 }, 0, 30);
  await page.keyboard.press("ArrowRight");
  await expect(detailPreview.getByText("2 of 2")).toBeVisible();
  await swipe({ x: 200, y: 300 }, 0, 250);
  await expect(detailPreview).toBeHidden();

  await image.click();
  await expect(preview.getByText("1 of 2")).toBeVisible();
  await pinch("touchStart", [
    { id: 1, x: 180, y: 450 },
    { id: 2, x: 210, y: 450 },
  ]);
  await pinch("touchMove", [
    { id: 1, x: 120, y: 450 },
    { id: 2, x: 300, y: 700 },
  ]);
  await pinch("touchEnd", []);
  await touch.detach();
  await screenshot(page, "conversation-attachment-zoom");
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});

test("reuses the fresh conversation feed after window focus", async ({
  page,
  dashboard,
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

  await page.goto(dashboard.baseURL);
  await expect(
    page.getByRole("navigation", { name: "Your conversations" }),
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
  dashboard,
}) => {
  const conversationId = "slack:CQA123:1770003600.000200";
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
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
  await expect(page.getByText(/Connect to send/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await context.setOffline(false);
  await expect(
    page.getByText("You’re offline. Drafts stay on this device."),
  ).toBeHidden();
  await expect(composer).toHaveValue("Keep this draft through reconnect");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("shows the repo name for one annotation scope on mobile", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(dashboard.baseURL);

  const conversation = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Checkout latency triage" }),
  });
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText("payments", { exact: true }),
  ).toBeVisible();
});

test("collapses long pending message stacks", async ({ page, dashboard }) => {
  const conversationId = "slack:CQA123:1770003600.000200";
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const pending = page.getByLabel("Pending messages");
  await expect(pending).toBeVisible();
  await expect(
    pending.getByRole("button", { name: "7 queued messages", exact: true }),
  ).toBeVisible();
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeHidden();

  await page.setViewportSize({ height: 1050, width: 1600 });
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
  await expect(pending.getByText("Fifth queued message.")).toBeHidden();

  await expand.click();
  await expect(
    pending.getByRole("button", { name: "Show fewer queued messages" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(pending.getByText("Fifth queued message.")).toBeVisible();
  await expect(pending.getByText("Seventh queued message.")).toBeVisible();

  await pending
    .getByRole("button", { name: "Show fewer queued messages" })
    .click();
  await expect(
    pending.getByRole("button", { name: "3 more queued messages" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("Fifth queued message.")).toBeHidden();
});

test("scrolls long conversation and transcript panes independently", async ({
  page,
  dashboard,
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
  await page.route(
    "**/api/conversations/long-0/pending-messages",
    async (route) => {
      await route.fulfill({
        json: { conversationId: "long-0", generatedAt, messages: [] },
      });
    },
  );
  await page.route("**/api/conversations/long-0*", async (route) => {
    await route.fulfill({
      json: withRequestedMailbox(route, {
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
      }),
    });
  });

  await page.goto(`${dashboard.baseURL}/conversations/long-0`);
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

test("shows personal spend and groups profile and session actions", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(dashboard.baseURL);

  const topBarTrigger = page.getByRole("button", {
    name: "Open profile menu for Dashboard User. Personal model spend: 7 days $0.46, 30 days $0.46.",
  });
  await expect(topBarTrigger).toBeVisible();
  await expect(topBarTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(topBarTrigger).toContainText(/7d\s*\$0\.46\s*30d\s*\$0\.46/, {
    useInnerText: true,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  const rail = page.locator('[data-slot="sidebar"]').filter({
    has: page.getByRole("navigation", { name: "Primary" }),
  });
  const trigger = rail.getByRole("button", {
    name: "Open profile menu for Dashboard User",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();

  const popover = page.locator("#profile-popover");
  await expect(popover.getByText("dev@example.com")).toBeVisible();
  await expect(popover).toContainText("7d $0.46");
  await expect(popover).toContainText("30d $0.46");
  await expect(
    popover.getByRole("link", { name: "My profile" }),
  ).toHaveAttribute("href", "/people/dev%40example.com");
  await expect(
    popover.getByRole("link", { name: "Settings", exact: true }),
  ).toHaveAttribute("href", "/settings");
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
  // Better Auth returns 415 for a sign-out body without a JSON content type.
  expect((await signOutRequest).headers()["content-type"]).toBe(
    "application/json",
  );
});

test.describe("keeps a hover-opened profile menu open on click", () => {
  test.use({ controlTimers: true });

  test("after the hover pause", async ({ page, dashboard }) => {
    await page.goto(dashboard.baseURL);
    const trigger = page.getByRole("button", {
      name: /^(Open|Close) profile menu for Dashboard User/,
    });
    await trigger.hover();
    await expect(page.locator("#profile-popover")).toBeVisible();
    // Pass Base UI's 500ms window that keeps a hover-opened popover open.
    await page.clock.fastForward(600);
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});

test("inspects and copies a child agent transcript", async ({
  context,
  page,
  dashboard,
}) => {
  const childConversationId = "junior:internal:dashboard-qa:advisor-plan";
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: dashboard.baseURL,
  });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
  );

  await expect(
    page.getByRole("heading", { name: "Dashboard QA edge cases" }),
  ).toBeVisible();
  // Subagent rows show in the main view, outside collapsed activity groups.
  const planner = page.getByRole("button", {
    name: "Open planner transcript",
  });
  const reviewer = page.getByRole("button", {
    name: "Open reviewer transcript",
  });
  await expect(planner).toContainText("Review the dashboard plan");
  await expect(reviewer).toContainText("blocked");
  await screenshot(page, "conversation-child-agents");

  // Details lists child agents with the runtime status.
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await expect(
    details.getByRole("heading", { name: "Subagents 2", exact: true }),
  ).toBeVisible();
  const subagents = details.getByRole("list", { name: "Subagents" });
  await expect(subagents.getByRole("listitem")).toHaveCount(2);
  await expect(subagents.getByRole("listitem").first()).toContainText(
    "GitHub access is needed to read the pull request.",
  );
  await screenshot(page, "conversation-subagents");
  // A row opens the same child transcript drawer as the transcript row.
  await subagents
    .getByRole("button", {
      name: /^blocked Review the open dashboard pull requests/,
    })
    .click();
  const reviewerDrawer = page.getByRole("dialog", { name: "reviewer" });
  await expect(
    reviewerDrawer.getByText("blocked", { exact: true }),
  ).toBeVisible();
  await expect(
    reviewerDrawer.getByRole("link", { name: "Open conversation" }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent("junior:internal:dashboard-qa:advisor-review")}`,
  );
  await page.keyboard.press("Escape");
  await expect(reviewerDrawer).toBeHidden();
  // The docked panel stays open beside the drawer.
  await expect(details).toBeVisible();

  await planner.click();

  const drawer = page.getByRole("dialog", {
    name: "Review the dashboard plan",
  });
  await expect(
    drawer.getByRole("heading", { name: "Review the dashboard plan" }),
  ).toBeVisible();
  await screenshot(page, "conversation-child-agent-drawer");
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
  // Child Conversations cannot be forked, so their replies offer only copy.
  await expect(
    drawer.getByText("Review complete; no blocking issues found."),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Fork after this message" }),
  ).toHaveCount(0);
  const reply = drawer
    .getByRole("article")
    .filter({ hasText: "Review complete; no blocking issues found." });
  await reply.hover();
  await reply.getByRole("button", { name: "Copy message" }).click();
  await expect(reply.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Review complete; no blocking issues found.",
  );

  // The shortcut searches the drawer's transcript, not the page behind it.
  await page.keyboard.press("ControlOrMeta+f");
  await expect(
    drawer.getByRole("searchbox", { name: "Search transcript" }),
  ).toBeFocused();
  await expect(
    page.getByRole("searchbox", { name: "Search transcript" }),
  ).toHaveCount(1);
  await drawer.getByRole("button", { name: "Hide search" }).click();

  await drawer.getByRole("button", { name: "Event log" }).click();
  const entry = drawer.getByRole("button", {
    name: "Event 0: message",
    exact: true,
  });
  await entry.click();
  const eventDetails = page.getByRole("dialog", {
    name: "Event details",
    exact: true,
  });
  await expect(
    eventDetails.getByRole("region", { name: "Message", exact: true }),
  ).toContainText("Review the dashboard plan before editing.");
  await page.keyboard.press("Escape");
  await expect(eventDetails).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(entry).toBeFocused();
  // A resize mounts the details sheet below the drawer without taking focus.
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(drawer).toBeVisible();
  await expect(
    page.locator('[data-dashboard-modal][aria-label="Conversation details"]'),
  ).toBeAttached();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(entry).toBeFocused();
});

test("shows the agent tree of a child agent conversation", async ({
  page,
  dashboard,
}) => {
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("junior:internal:dashboard-qa:advisor-plan")}`,
  );

  await expect(
    page.getByRole("heading", { name: "Review the dashboard plan" }),
  ).toBeVisible();
  const tree = page.getByRole("navigation", { name: "Agent tree" });
  await expect(
    tree.getByRole("link", { name: "Dashboard QA edge cases" }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
  );
  await expect(tree).not.toContainText("Review the dashboard plan");
  await expect(
    page.getByText("Review complete; no blocking issues found."),
  ).toBeVisible();
  await screenshot(page, "conversation-child-agent-page");

  await tree.getByRole("link", { name: "Dashboard QA edge cases" }).click();
  await expect(
    page.getByRole("heading", { name: "Dashboard QA edge cases" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Agent tree" }),
  ).toHaveCount(0);
});
