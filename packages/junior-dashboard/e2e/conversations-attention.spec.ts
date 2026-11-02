import { expect, test } from "./test";
import { screenshot } from "./screenshot";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const WAITING_CONVERSATION_ID = "slack:CQA123:1770000000.000100";
const FINISHED_CONVERSATION_ID = "agent-dispatch:event-1";

test.describe("Needs attention section", () => {
  test("puts waiting conversations first and collapses sections", async ({
    page,
    dashboard,
  }) => {
    await page.route("**/api/review-items/waiting-conversations", (route) =>
      route.fulfill({ json: { conversationIds: [WAITING_CONVERSATION_ID] } }),
    );
    await page.goto(dashboard.baseURL);

    const list = page.getByRole("list", { name: "Your conversations" });
    const attention = list.getByRole("button", { name: "Needs attention" });
    const priority = list.getByRole("button", { name: "Priority" });
    const waitingCard = list.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Checkout latency triage" }),
    });
    await expect(list.getByRole("button").first()).toHaveText(
      "Needs attention",
    );
    await expect(attention).toHaveAttribute("aria-expanded", "true");
    await expect(
      waitingCard.getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    await screenshot(page, "conversations-needs-attention");

    await attention.click();
    await priority.click();
    await expect(attention).toHaveAttribute("aria-expanded", "false");
    await expect(attention).toHaveText("Needs attention1");
    await expect(priority).toHaveAttribute("aria-expanded", "false");
    await expect(waitingCard).toHaveCount(0);
    await screenshot(page, "conversations-sections-collapsed");

    await page.reload();
    await expect(attention).toHaveAttribute("aria-expanded", "false");
    await expect(priority).toHaveAttribute("aria-expanded", "false");
    await expect(waitingCard).toHaveCount(0);

    await attention.click();
    await expect(waitingCard).toBeVisible();
  });

  test("shows finished conversations until the viewer opens them", async ({
    page,
    dashboard,
  }) => {
    // The viewer last read the conversation before its final activity. Seed
    // it once, before the app reads storage on the first load.
    await page.addInitScript((conversationId) => {
      if (window.sessionStorage.getItem("qa:seeded")) return;
      window.sessionStorage.setItem("qa:seeded", "true");
      window.localStorage.setItem(
        "junior:conversation-finished-indicators",
        JSON.stringify({
          [conversationId]: { lastReadAt: "2026-08-07T08:00:00.000Z" },
        }),
      );
    }, FINISHED_CONVERSATION_ID);
    await page.goto(dashboard.baseURL);

    const list = page.getByRole("list", { name: "Your conversations" });
    const finishedCard = list.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Closed issue summary" }),
    });
    await expect(list.getByRole("button").first()).toHaveText(
      "Needs attention",
    );
    await expect(
      finishedCard.getByRole("img", { name: "Finished since last viewed" }),
    ).toBeVisible();
    await screenshot(page, "conversations-needs-attention-finished", {
      view: "desktop",
    });

    await finishedCard
      .getByRole("link", { name: "Open Closed issue summary" })
      .click();
    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    await expect(
      sidebar.getByRole("link", { name: /Closed issue summary/ }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      sidebar.getByRole("button", { name: "Needs attention" }),
    ).toHaveCount(0);

    await page.goto(dashboard.baseURL);
    await expect(list.getByRole("button").first()).not.toHaveText(
      "Needs attention",
    );
    await expect(
      finishedCard.getByRole("img", { name: "Finished since last viewed" }),
    ).toHaveCount(0);
  });

  test("collapses sidebar sections", async ({ page, dashboard }) => {
    await page.route("**/api/review-items/waiting-conversations", (route) =>
      route.fulfill({ json: { conversationIds: [WAITING_CONVERSATION_ID] } }),
    );
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    );
    const sidebar = page.getByRole("navigation", {
      name: "Your conversations",
    });
    const attention = sidebar.getByRole("button", { name: "Needs attention" });
    const today = sidebar.getByRole("button", { name: "Today" });
    const todayRow = sidebar.getByRole("link", {
      name: /Closed issue summary/,
    });
    await expect(sidebar.getByRole("button").first()).toHaveText(
      "Needs attention",
    );
    await expect(
      sidebar.getByRole("link", { name: /Checkout latency triage/ }),
    ).toBeVisible();
    await expect(todayRow).toBeVisible();
    await screenshot(page, "conversation-sidebar-needs-attention", {
      view: "desktop",
    });

    await today.click();
    await expect(today).toHaveAttribute("aria-expanded", "false");
    await expect(todayRow).toHaveCount(0);
    await expect(attention).toHaveAttribute("aria-expanded", "true");
    await screenshot(page, "conversation-sidebar-collapsed", {
      view: "desktop",
    });

    await today.click();
    await expect(todayRow).toBeVisible();
  });
});
