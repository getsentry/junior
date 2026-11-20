import type { Page } from "@playwright/test";

import {
  automationAlert,
  conversationId,
  expandRow,
  grab,
  license,
  migration,
  mockReviewItems,
  mockViewerCodeChanges,
  prMerge,
  prReview,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  // One ask, so its row's Done takes the count to zero.
  async function mockOneAsk(page: Page) {
    await mockReviewItems(page, { automations: () => 0, open: [rollout] });
  }

  function inboxTab(page: Page) {
    return page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ });
  }

  // Record every title write. A pinned tab marks each one as an update.
  async function recordTitles(page: Page) {
    await page.addInitScript(() => {
      const titles: string[] = [];
      Object.assign(window, { __titles: titles });
      const own = Object.getOwnPropertyDescriptor(Document.prototype, "title")!;
      Object.defineProperty(document, "title", {
        configurable: true,
        get: () => own.get!.call(document),
        set: (value: string) => {
          titles.push(value);
          own.set!.call(document, value);
        },
      });
    });
  }

  /** The titles written since the page loaded. */
  function recordedTitles(page: Page): Promise<string[]> {
    return page.evaluate(
      () => (window as Window & { __titles?: string[] }).__titles ?? [],
    );
  }

  function navEntry(page: Page, label: string) {
    return page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: new RegExp(`^${label}`) });
  }

  /** Answer an open question with its first field's choice, then Send. */
  async function answer(page: Page, title: string, choice: string) {
    const ask = page.getByRole("region", { name: title, exact: true });
    await ask.getByRole("radio", { name: choice }).click();
    await ask.getByRole("button", { name: "Send" }).click();
  }

  async function closeCheckoutAsks(page: Page) {
    await expandRow(rowHead(page, checkout));
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  }

  test("the tab title counts the Inbox, as its badge does", async ({
    dashboard,
    page,
  }) => {
    await mockOneAsk(page);
    await page.goto(`${dashboard.baseURL}/`);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 1 waiting");
    await expect(page).toHaveTitle("(1) Inbox - Junior");

    // Other pages keep their own title part after the count.
    await page.goto(`${dashboard.baseURL}/settings`);
    await expect(page).toHaveTitle("(1) Settings - Junior");

    await page.goto(`${dashboard.baseURL}/`);
    await closeCheckoutAsks(page);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox");
    await expect(page).toHaveTitle("Inbox - Junior");
  });

  test("the tab icon shows the Inbox count until it is zero", async ({
    dashboard,
    page,
  }) => {
    await mockOneAsk(page);
    await page.goto(`${dashboard.baseURL}/`);
    const icon = page.locator('link[rel="icon"]');
    await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

    await closeCheckoutAsks(page);
    await expect(page).toHaveTitle("Inbox - Junior");
    await expect(icon).toHaveAttribute("href", "/favicon.ico");
  });

  test("turning off the tab count hides it in the title and on the icon", async ({
    dashboard,
    page,
  }) => {
    await mockOneAsk(page);
    await page.goto(`${dashboard.baseURL}/settings`);
    const icon = page.locator('link[rel="icon"]');
    const showCount = page.getByRole("checkbox", {
      name: "Show the Inbox count in the tab",
    });
    await expect(showCount).toBeChecked();
    await expect(page).toHaveTitle("(1) Settings - Junior");
    await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

    await showCount.click();
    await expect(icon).toHaveAttribute("href", "/favicon.ico");
    await expect(page).toHaveTitle("Settings - Junior");

    // The choice stays on this browser.
    await page.reload();
    await expect(showCount).not.toBeChecked();
    await expect(page).toHaveTitle("Settings - Junior");
    await expect(icon).toHaveAttribute("href", "/favicon.ico");
  });

  test.describe("in a hidden tab", () => {
    test.use({ controlTimers: true });
    test("the tab count refreshes about once a minute", async ({
      dashboard,
      page,
    }) => {
      // The mock counts this list on each request.
      const open: unknown[] = [rollout];
      await mockReviewItems(page, { automations: () => 0, open });
      const versions = {
        conversationDetails: {},
        conversations: "mock",
        reviewItems: "review-1",
        spend: "mock",
      };
      // Page clock time of each answered check.
      const checks: number[] = [];
      // A timer that fires while a check is in flight joins that check. Let
      // the page finish each answer before the clock moves.
      const answered = async (count: number) => {
        await expect.poll(() => checks.length).toBe(count);
        await page.evaluate(
          () => new Promise((resolve) => setTimeout(resolve)),
        );
      };
      await page.route("**/api/versions*", async (route) => {
        const at = await page.evaluate(() => Date.now());
        await route.fulfill({ json: versions });
        checks.push(at);
      });
      await page.goto(`${dashboard.baseURL}/settings`);
      await expect(page).toHaveTitle("(1) Settings - Junior");
      await answered(1);
      const icon = page.locator('link[rel="icon"]');
      await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);
      const oneIcon = await icon.getAttribute("href");

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // The check that was due runs, then one each minute.
      await page.clock.fastForward(5_000);
      await answered(2);
      open.push(license);
      versions.reviewItems = "review-2";
      await page.clock.fastForward(30_000);
      await page.clock.fastForward(30_000);
      await answered(3);
      expect(checks[2]! - checks[1]!).toBeGreaterThanOrEqual(60_000);
      await expect(page).toHaveTitle("(2) Settings - Junior");
      await expect(icon).not.toHaveAttribute("href", oneIcon!);
      await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);
    });
  });

  test("moving between pages never flashes the bare agent name in the tab", async ({
    dashboard,
    page,
  }) => {
    await recordTitles(page);
    await mockOneAsk(page);
    await page.goto(`${dashboard.baseURL}/`);
    await expect(page).toHaveTitle("(1) Inbox - Junior");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: /^Pull requests/ }).click();
    await expect(page).toHaveTitle("(1) Pull requests - Junior");
    await nav.getByRole("link", { name: /^Snoozed/ }).click();
    await expect(page).toHaveTitle("(1) Snoozed - Junior");
    await inboxTab(page).click();
    await expect(page).toHaveTitle("(1) Inbox - Junior");

    const all = await recordedTitles(page);
    // From the first counted title on: the count loads after the page title.
    const titles = all.slice(all.indexOf("(1) Inbox - Junior"));
    expect(titles).toContain("(1) Pull requests - Junior");
    expect(titles.filter((title) => /^(\(\d+\) )?Junior$/.test(title))).toEqual(
      [],
    );
  });

  test("the tab count counts an Automation alert, and its snooze leaves the count", async ({
    dashboard,
    page,
  }) => {
    const alert = automationAlert("event-1", "Closed issue summary");
    await mockReviewItems(page, { open: [rollout, alert] });
    await page.goto(`${dashboard.baseURL}/`);
    await expect(page).toHaveTitle("(2) Inbox - Junior");
    const todo = page.getByRole("region", { name: "To do" });
    await rowHead(todo, alert.title).hover();
    await todo.getByRole("button", { exact: true, name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(page).toHaveTitle("(1) Inbox - Junior");

    // The server keeps the snooze, so a reload never counts the alert.
    await recordTitles(page);
    await page.reload();
    await expect(rowHead(page, checkout)).toBeVisible();
    await expect(page).toHaveTitle("(1) Inbox - Junior");
    expect(
      (await recordedTitles(page)).filter((title) => title.startsWith("(2) ")),
    ).toEqual([]);
  });
  test("To do counts its rows, also each row of a stack, before and after an answer", async ({
    dashboard,
    page,
  }) => {
    // Two asks in one Conversation make a stack of two rows, and one ask
    // makes another row.
    await mockReviewItems(page, {
      automations: () => 0,
      open: [rollout, migration, license],
    });
    await page.goto(`${dashboard.baseURL}/`);
    const todo = page.getByRole("region", { name: "To do" });
    const cards = todo.locator("[data-inbox-row]");
    await expect(cards).toHaveCount(3);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 3 waiting");
    await expect(page).toHaveTitle("(3) Inbox - Junior");
    await expect(todo.getByText("3", { exact: true })).toBeVisible();

    await expandRow(rowHead(todo, license.title));
    await answer(page, license.title, "Approve");
    await expect(cards).toHaveCount(2);
    await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 2 waiting");
    await expect(page).toHaveTitle("(2) Inbox - Junior");
  });

  test("Decisions counts every question that it lists, before and after an answer", async ({
    dashboard,
    page,
  }) => {
    // A question for Everyone is a Decisions row too.
    await mockReviewItems(page, {
      automations: () => 0,
      open: [license, grab],
    });
    await page.goto(`${dashboard.baseURL}/?view=decisions`);
    const rows = page
      .getByRole("region", { name: "Decisions" })
      .locator("[data-inbox-row]");
    await expect(rows).toHaveCount(2);
    await expect(navEntry(page, "Decisions")).toHaveText(/^Decisions\s*2$/);

    await rowHead(page, license.title).click();
    await answer(page, license.title, "Approve");
    await expect(rows).toHaveCount(1);
    await expect(navEntry(page, "Decisions")).toHaveText(/^Decisions\s*1$/);
  });

  test("Pull requests counts the changes under Waiting on you, before and after a dismiss", async ({
    dashboard,
    page,
  }) => {
    // A second ask on #42 shares its change, and #42 is a draft.
    const squash = {
      ...license,
      owner: { id: conversationId, kind: "conversation" },
      rootConversationId: conversationId,
      id: "item-pr-squash",
      subject: prMerge.subject,
      title: "Squash #42 before the merge?",
    };
    await mockReviewItems(page, {
      automations: () => 0,
      open: [prMerge, squash, prReview],
    });
    await mockViewerCodeChanges(page, [
      { draft: true, idleDays: 0, number: 42, title: "Retry checkout writes" },
      { idleDays: 1, number: 91, title: "Pin the release train" },
    ]);
    await page.goto(`${dashboard.baseURL}/?view=prs`);
    const waiting = page
      .getByRole("region", { name: "Waiting on you" })
      .locator('[data-dock-key^="change:"]');
    await expect(waiting).toHaveCount(2);
    await expect(navEntry(page, "Pull requests")).toHaveText(
      /^Pull requests\s*2$/,
    );

    await rowHead(page, prReview.title).click();
    await page
      .locator("li[data-expanded]")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(waiting).toHaveCount(1);
    await expect(navEntry(page, "Pull requests")).toHaveText(
      /^Pull requests\s*1$/,
    );
  });
});
