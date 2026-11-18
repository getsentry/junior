import type { Page } from "@playwright/test";

import { mockAutomationCollection } from "../../src/mock-reporting/automation-collection";
import { attentionCount, automationReport } from "./automation-fixture";
import {
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

  test("the tab count waits for the alerts that this browser put away", async ({
    dashboard,
    page,
  }) => {
    const report = structuredClone(automationReport);
    const blocked = report.automations[1]!;
    Object.assign(blocked, {
      lastRunAt: "2026-01-01T10:00:00.000Z",
      lastRunStatus: "blocked",
      status: "blocked",
      statusReason: "GitHub access expired.",
    });
    const total = 1 + attentionCount(report);
    await mockReviewItems(page, {
      automations: () => attentionCount(report),
      open: [rollout],
    });
    // The attention list can be held, as a slow list is on a real server.
    let held: Promise<void> | undefined;
    let release = () => {};
    await page.route(/\/api\/automations(?:\?.*)?$/, async (route) => {
      await held;
      await route.fulfill({
        json: mockAutomationCollection(
          report,
          new URL(route.request().url()).searchParams,
        ),
      });
    });
    await page.goto(`${dashboard.baseURL}/`);
    await expect(page).toHaveTitle(`(${total}) Inbox - Junior`);
    const todo = page.getByRole("region", { name: "To do" });
    await todo.getByRole("button", { name: new RegExp(blocked.title) }).click();
    await page
      .getByRole("region", { name: `${blocked.title}: attention` })
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(page).toHaveTitle(`(${total - 1}) Inbox - Junior`);

    // Reload while the list that says which alert was put away is held.
    held = new Promise((resolve) => {
      release = resolve;
    });
    await recordTitles(page);
    const counted = page.waitForResponse((response) =>
      response.url().includes("/api/review-items/count"),
    );
    await page.reload();
    await counted;
    await expect(rowHead(page, checkout)).toBeVisible();
    // Let the count render before the list arrives.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    release();
    await expect(page).toHaveTitle(`(${total - 1}) Inbox - Junior`);
    // The count never showed the put-away alert, so it never dropped.
    expect(
      (await recordedTitles(page)).filter((title) =>
        title.startsWith(`(${total}) `),
      ),
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
      addedByConversationId: conversationId,
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
