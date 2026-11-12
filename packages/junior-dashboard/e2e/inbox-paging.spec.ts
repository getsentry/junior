/** The Inbox lists' pages: next pages, To do's own paging, and failed pages. */
import type { Page } from "@playwright/test";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import {
  answered,
  license,
  mockReviewItems,
  mockViewerCodeChanges,
  prMerge,
  prReady,
  prReview,
  rollout,
} from "./inbox-fixture";
import { expect, test } from "./test";

test("the asks and Done load their next pages at the end of the list", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, {
    open: [prReview, prMerge, prReady],
    pageSize: 1,
  });
  // No code changes, so the asks are the whole list and its end shows.
  await mockViewerCodeChanges(page, []);
  const cursors: string[] = [];
  page.on("request", (request) => {
    const cursor = new URL(request.url()).searchParams.get("cursor");
    if (request.url().includes("/api/review-items?") && cursor)
      cursors.push(cursor);
  });
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  // Each PR is on its own page; the list loads the next as its end shows.
  await expect(
    page.locator("section[aria-label] section[aria-label]"),
  ).toHaveText([/^Waiting on you/, /^Waiting on others/]);
  await expect(page.getByText("Loading more…")).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Inbox" })
    .getByRole("link", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Digest skipped/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /initech license entry/ }),
  ).toBeVisible();
  expect(cursors).toEqual(expect.arrayContaining(["1", "2"]));
});

test("Pull requests lists every open change, past the first page", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [] });
  // The server lists the longest idle first, so the freshest come last.
  await mockViewerCodeChanges(page, [
    ...Array.from({ length: 100 }, (_, index) => ({
      idleDays: 3 + index / 100,
      number: 1000 + index,
      title: `Older change ${index + 1}`,
    })).reverse(),
    ...Array.from({ length: 5 }, (_, index) => ({
      idleDays: 0,
      number: 2000 + index,
      title: `Fresh change ${index + 1}`,
    })),
  ]);
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  const others = page
    .getByRole("region", { name: "Waiting on others" })
    .getByRole("listitem");
  await expect(others).toHaveCount(105);
  await expect(others.first()).toHaveText(/Fresh change/);
});

test("To do lists its rows while the count is pending or failed", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { open: [license] });
  const todo = page.getByRole("region", { name: "To do" });
  const row = todo.getByRole("link", { name: new RegExp(license.title) });
  // A failed count leaves the badge without a number, not To do empty.
  await page.route("**/api/review-items/count", (route) =>
    route.fulfill({ json: { error: "Failed" }, status: 500 }),
  );
  await page.goto(`${dashboard.baseURL}/`);
  await expect(row).toBeVisible();
  // A count that never answers does the same.
  await page.unroute("**/api/review-items/count");
  await page.route("**/api/review-items/count", () => undefined);
  await page.reload();
  await expect(row).toBeVisible();
});

test("a failed next page waits for Try again", async ({ dashboard, page }) => {
  await mockReviewItems(page, {
    open: [prReview, prMerge, prReady],
    pageSize: 1,
  });
  // No code changes, so the asks are the whole list and its end shows.
  await mockViewerCodeChanges(page, []);
  let attempts = 0;
  await page.route(/\/api\/review-items\?.*cursor=1(?:&|$)/, (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ json: { error: "Failed" }, status: 500 })
      : route.fallback();
  });
  await page.goto(`${dashboard.baseURL}/?view=prs`);
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(page.getByText("Could not load more.")).toBeVisible();
  // Two frames later, the list has not asked again on its own.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(attempts).toBe(1);
  await retry.click();
  // The retried page loads, and the pages after it load on their own.
  await expect(
    page.locator("section[aria-label] section[aria-label]"),
  ).toHaveText([/^Waiting on you/, /^Waiting on others/]);
  await expect(retry).toHaveCount(0);
});

test("To do loads its next asks at its own end", async ({
  dashboard,
  page,
}) => {
  // Each ask is in its own Conversation, so the stream below To do is long
  // and its end stays out of view.
  const asks = Array.from({ length: 30 }, (_, index) => ({
    ...license,
    addedByConversationId: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
    conversationIds: [],
    createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
    id: `item-todo-${index}`,
    title: `Approve rollout step ${index}`,
  }));
  await mockReviewItems(page, { open: asks, pageSize: 10 });
  await page.goto(`${dashboard.baseURL}/`);
  const rows = page
    .getByRole("region", { name: "To do" })
    .locator("[data-inbox-row]");
  await expect(rows).toHaveCount(10);
  // Its end loads the next page while it shows fewer than its count.
  await expect(async () => {
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(30, { timeout: 1_000 });
  }).toPass();
});

/** 30 old notices, each in its own Conversation, and one new ask. */
function askBehindNotices() {
  const notices = Array.from({ length: 30 }, (_, index) => ({
    ...prReady,
    addedByConversationId: `slack:CNOTE:17700${String(index).padStart(5, "0")}.000100`,
    conversationIds: [],
    createdAt: new Date(NOW_MS - (60 - index) * 3_600_000).toISOString(),
    id: `item-notice-${index}`,
    subject: undefined,
    title: `Deploy note ${index}`,
  }));
  const ask = {
    ...license,
    addedByConversationId: "slack:CASK:1770000000.000100",
    conversationIds: [],
    createdAt: new Date(NOW_MS - 60_000).toISOString(),
  };
  return { ask, notices };
}

/** Later pages of the Review item list never load. */
async function holdLaterReviewItemPages(page: Page) {
  await page.route(/\/api\/review-items\?.*cursor=/, () => undefined);
}

test("To do's first page holds the new ask behind older notices", async ({
  dashboard,
  page,
}) => {
  const { ask, notices } = askBehindNotices();
  await mockReviewItems(page, { open: [...notices, ask], pageSize: 25 });
  await holdLaterReviewItemPages(page);
  await page.goto(`${dashboard.baseURL}/`);
  const rows = page
    .getByRole("region", { name: "To do" })
    .locator("[data-inbox-row]");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(ask.title);
});

test("a collapsed To do loads its first page, so it expands with its rows", async ({
  dashboard,
  page,
}) => {
  const { ask, notices } = askBehindNotices();
  await mockReviewItems(page, { open: [...notices, ask], pageSize: 25 });
  await holdLaterReviewItemPages(page);
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  await todo.getByRole("button", { name: /^To do/ }).click();
  await expect(todo.locator("[data-inbox-row]")).toHaveCount(0);

  // First-page reads only. Later pages are held, so an expanded row can
  // come only from the first page.
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/\/api\/review-items\?/.test(url) && !url.includes("cursor="))
      reads.push(url);
  });
  await page.reload();
  // The first page is in: the newest notice on it shows below To do.
  await expect(
    page.locator("[data-inbox-row]").filter({ hasText: "Deploy note 29" }),
  ).toBeVisible();
  const collapsed = page.getByRole("button", {
    expanded: false,
    name: /^To do/,
  });
  await expect(collapsed).toBeVisible();
  const readsBefore = reads.length;
  await collapsed.click();
  await expect(todo.locator("[data-inbox-row]")).toContainText(ask.title);
  expect(reads).toHaveLength(readsBefore);
});

test("To do pages to its end when the count or the Automations fail", async ({
  dashboard,
  page,
}) => {
  const asks = Array.from({ length: 30 }, (_, index) => ({
    ...license,
    addedByConversationId: `slack:CTODO:17700${String(index).padStart(5, "0")}.000100`,
    conversationIds: [],
    createdAt: new Date(NOW_MS - index * 60_000).toISOString(),
    id: `item-todo-${index}`,
    title: `Approve rollout step ${index}`,
  }));
  await mockReviewItems(page, { open: asks, pageSize: 10 });
  // The count only feeds the badge, so its failure cannot stop To do.
  await page.route("**/api/review-items/count**", (route) =>
    route.fulfill({ json: { error: "Count failed" }, status: 500 }),
  );
  await page.route(/\/api\/automations\?scope=attention/, (route) =>
    route.fulfill({ json: { error: "Automations failed" }, status: 500 }),
  );
  await page.goto(`${dashboard.baseURL}/`);
  const rows = page
    .getByRole("region", { name: "To do" })
    .locator("[data-inbox-row]");
  await expect(rows).toHaveCount(10);
  await expect(async () => {
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(30, { timeout: 1_000 });
  }).toPass();
});

test("Done shows Try again when its first read fails", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  let fail = true;
  await page.route(/\/api\/review-items\?.*status=done/, async (route) => {
    if (!fail) return route.fallback();
    fail = false;
    return route.fulfill({ json: { error: "Read failed" }, status: 500 });
  });
  await page.goto(`${dashboard.baseURL}/?view=done`);
  await expect(page.getByText("Could not load Done.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(answered.title) }),
  ).toBeVisible();
});
