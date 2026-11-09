import type { Page } from "@playwright/test";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

const ROOT_ID = "internal:dashboard-qa";
const THREAD_ID = "junior:internal:dashboard-qa:thread";
const NESTED_THREAD_ID = "junior:internal:dashboard-qa:thread:nested";
const TASK_ID = "junior:internal:dashboard-qa:advisor-plan";
const ARCHIVED_THREAD_ID = "junior:internal:dashboard-qa:archived-thread";

/** Make one Conversation wait on the viewer, as an open Review item does. */
async function mockWaiting(page: Page, conversationId: string) {
  await page.route("**/api/review-items/waiting-conversations", (route) =>
    route.fulfill({
      json: {
        conversations: [
          {
            conversationId,
            items: [{ title: "Pick a fix" }],
            waitingSince: "2026-08-07T08:00:00.000Z",
          },
        ],
      },
    }),
  );
}

test("shows Threads under their parent and in details", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(ROOT_ID)}`,
  );

  const sidebar = page.getByRole("navigation", { name: "Your conversations" });
  // An archived Thread drops out of the sidebar.
  await expect(
    sidebar.getByRole("link", { name: /Compare sidebar badges/ }),
  ).toHaveCount(0);

  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  const threads = details.getByRole("region", { name: "Threads" });
  await expect(threads.getByRole("listitem")).toHaveCount(1);
  await threads.getByRole("button", { name: "Show archived (1)" }).click();
  await expect(
    threads.getByRole("link", { name: /^archived Compare sidebar badges/ }),
  ).toBeVisible();
  await threads.getByRole("button", { name: "Hide archived" }).click();
  await expect(threads.getByRole("listitem")).toHaveCount(1);

  // A Thread under a Thread follows its parent row. The indent is left to
  // visual QA.
  const threadRow = sidebar.getByRole("link", {
    name: /Check pinned row order/,
  });
  const rowNames = await sidebar.getByRole("link").allTextContents();
  const parentIndex = rowNames.findIndex((name) =>
    name.includes("Check pinned row order"),
  );
  expect(parentIndex).toBeGreaterThan(-1);
  expect(rowNames[parentIndex + 1]).toContain("Recheck pin order in Safari");

  // A Thread opens its own page, and its sidebar row is the current page.
  await threadRow.click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`,
  );
  await expect(threadRow).toHaveAttribute("aria-current", "page");
  await details.getByRole("link", { name: "Dashboard QA edge cases" }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(ROOT_ID)}`,
  );
});

test("sends a message from a Thread page", async ({ page, dashboard }) => {
  const message = "Check the row order again";
  const sends: Array<{ message: string; url: string }> = [];
  await page.route("**/api/conversations/*/messages", async (route) => {
    const body = route.request().postDataJSON() as { message: string };
    sends.push({ message: body.message, url: route.request().url() });
    await route.fulfill({
      json: {
        conversationId: THREAD_ID,
        messageId: "thread-message",
        status: "accepted",
      },
    });
  });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`,
  );

  // A person can message a Thread, unlike a Task.
  await page.getByLabel("Continue this conversation").fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => sends)
    .toEqual([
      {
        message,
        url: `${dashboard.baseURL}/api/conversations/${encodeURIComponent(THREAD_ID)}/messages`,
      },
    ]);
  await expect(page.getByText(message)).toBeVisible();
});

/** Record archive calls and hold them until the test releases them. */
async function holdArchives(page: Page) {
  const calls: Array<{
    applyToChildren?: boolean;
    archived: boolean;
    url: string;
  }> = [];
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/conversations/*/archive", async (route) => {
    const body = route.request().postDataJSON() as {
      applyToChildren?: boolean;
      archived: boolean;
    };
    calls.push({
      applyToChildren: body.applyToChildren,
      archived: body.archived,
      url: route.request().url(),
    });
    await released;
    await route.continue();
  });
  return { calls, release: () => release?.() };
}

test("archives a Thread from its page", async ({ page, dashboard }) => {
  const { calls: archiveCalls, release: releaseArchive } =
    await holdArchives(page);
  const threadUrl = `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`;
  const threadArchiveUrl = `${dashboard.baseURL}/api/conversations/${encodeURIComponent(THREAD_ID)}/archive`;
  await page.goto(threadUrl);
  const sidebar = page.getByRole("navigation", { name: "Your conversations" });
  const threadRow = sidebar.getByRole("link", {
    name: /Check pinned row order/,
  });
  const nestedRow = sidebar.getByRole("link", {
    name: /Recheck pin order in Safari/,
  });
  const rootRow = sidebar.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  const openMenu = page.getByRole("button", {
    name: "Conversation menu",
    exact: true,
  });
  const openMenus = page.getByRole("button", {
    name: "Close conversation menu",
  });
  await expect(threadRow).toBeVisible();
  await expect(nestedRow).toBeVisible();

  // A Thread archive is for everyone and takes its nested Thread with it, so
  // it asks first. The page goes home like any archive.
  await openMenu.click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(openMenus).toHaveCount(0);
  await page
    .getByRole("alertdialog", { name: "Also archive its child conversations?" })
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page).toHaveURL(new URL("/", dashboard.baseURL).href);
  await expect
    .poll(() => archiveCalls)
    .toEqual([
      { applyToChildren: true, archived: true, url: threadArchiveUrl },
    ]);
  // The rows hide while the archive is still in flight, so the feed update
  // is the optimistic one, not a refetch.
  await expect(threadRow).toHaveCount(0);
  await expect(nestedRow).toHaveCount(0);
  // A feed refetch during the archive still has both Threads. They stay
  // hidden until the archive settles.
  await page.clock.setFixedTime(NOW_MS + 60_000);
  const refetch = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/conversations",
  );
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await refetch;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(threadRow).toHaveCount(0);
  await expect(nestedRow).toHaveCount(0);
  releaseArchive();
  await expect(rootRow).toBeVisible();

  // An archived Thread stays readable, and Unarchive brings its row back.
  await page.goto(threadUrl);
  await openMenu.click();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(threadRow).toBeVisible();
  await expect(nestedRow).toBeVisible();
  await expect(openMenus).toHaveCount(0);
  await expect
    .poll(() => archiveCalls)
    .toEqual([
      { applyToChildren: true, archived: true, url: threadArchiveUrl },
      { applyToChildren: true, archived: false, url: threadArchiveUrl },
    ]);
});

test("archives a nested Thread without its parent", async ({
  page,
  dashboard,
}) => {
  const archive = await holdArchives(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(NESTED_THREAD_ID)}`,
  );
  const sidebar = page.getByRole("navigation", { name: "Your conversations" });
  const threadRow = sidebar.getByRole("link", {
    name: /Check pinned row order/,
  });
  const nestedRow = sidebar.getByRole("link", {
    name: /Recheck pin order in Safari/,
  });
  await expect(nestedRow).toHaveAttribute("aria-current", "page");

  await page
    .getByRole("button", { name: "Conversation menu", exact: true })
    .click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Archive for everyone?" })
    .getByRole("button", { name: "Archive" })
    .click();
  await expect.poll(() => archive.calls.length).toBe(1);
  // The nested row hides at once. Its parent Thread stays.
  await expect(nestedRow).toHaveCount(0);
  await expect(threadRow).toBeVisible();
  archive.release();

  // Undo puts the nested row back under its parent before the restore
  // settles, so it does not wait on a feed refetch.
  const restore = await holdArchives(page);
  await page
    .getByRole("button", { name: /Undo archive for Recheck pin order/ })
    .click();
  await expect.poll(() => restore.calls.length).toBe(1);
  await expect(nestedRow).toBeVisible();
  const rowNames = await sidebar.getByRole("link").allTextContents();
  const parentIndex = rowNames.findIndex((name) =>
    name.includes("Check pinned row order"),
  );
  expect(rowNames[parentIndex + 1]).toContain("Recheck pin order in Safari");
  restore.release();
});

test("hides the composer on a Task page", async ({ page, dashboard }) => {
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(TASK_ID)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Review the dashboard plan" }),
  ).toBeVisible();
  // Only the parent agent gives a Task its input.
  await expect(page.getByLabel("Continue this conversation")).toHaveCount(0);
});

test("links Threads and collapses Tasks in the parent transcript", async ({
  page,
  dashboard,
}) => {
  await mockWaiting(page, THREAD_ID);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(ROOT_ID)}`,
  );
  const transcript = page.getByLabel("Conversation transcript");

  // A Thread card shows the Thread's own title and its runtime status.
  const threadCard = transcript.getByRole("link", {
    name: /Check pinned row order/,
  });
  await expect(threadCard).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent(THREAD_ID)}`,
  );
  await expect(threadCard).toContainText("Waiting on you");
  // The feed leaves out an archived Thread, so its card has no status.
  const archivedCard = transcript.getByRole("link", {
    name: /Compare sidebar badges/,
  });
  await expect(archivedCard).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent(ARCHIVED_THREAD_ID)}`,
  );
  await expect(archivedCard).not.toContainText(/Idle|Running|Waiting/);

  // A run of Tasks is one line. It expands to rows that open the drawer.
  const tasksLine = transcript.getByRole("button", { name: /^2 Tasks/ });
  await expect(tasksLine).toHaveAttribute("aria-expanded", "false");
  await tasksLine.click();
  await screenshot(page, "conversation-task-line");
  await transcript
    .getByRole("button", { name: "Open Review the dashboard plan transcript" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review the dashboard plan" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await archivedCard.scrollIntoViewIfNeeded();
  await screenshot(page, "conversation-thread-cards", { view: "desktop" });
  await page.setViewportSize({ height: 844, width: 390 });
  await archivedCard.scrollIntoViewIfNeeded();
  await screenshot(page, "conversation-thread-cards", { view: "mobile" });
  await page.setViewportSize({ height: 900, width: 1440 });
  await threadCard.click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`,
  );
});

test("shows the breadcrumb, status, and Turn authors of a Thread", async ({
  page,
  dashboard,
}) => {
  await mockWaiting(page, THREAD_ID);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`,
  );

  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("heading", { name: "Check pinned row order" }),
  ).toBeVisible();
  await expect(
    breadcrumb.getByRole("link", { name: "Dashboard QA edge cases" }),
  ).toHaveAttribute("href", `/conversations/${encodeURIComponent(ROOT_ID)}`);
  // The pill comes from runtime state: an open Review item waits on the
  // viewer.
  const header = page.locator("header").filter({ has: breadcrumb });
  await expect(
    header.getByText("Waiting on you").filter({ visible: true }),
  ).toBeVisible();

  // The parent agent started the first Turn; a person started the next.
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("Parent agent")).toBeVisible();
  await expect(transcript.getByText("Taylor Chen")).toBeVisible();
  // A Watch Event of the Thread shows as an Event, not as parent input.
  await expect(
    transcript.getByText(/getsentry\/junior#2950 checks failed/),
  ).toBeVisible();
  await screenshot(page, "conversation-thread-page");

  // A nested Thread links each Thread above it by its own title.
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(NESTED_THREAD_ID)}`,
  );
  await expect(
    breadcrumb.getByRole("heading", { name: "Recheck pin order in Safari" }),
  ).toBeVisible();
  await breadcrumb
    .getByRole("link", { name: "Check pinned row order" })
    .click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`,
  );
});

test("shows the breadcrumb and status of a Task", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(TASK_ID)}`,
  );
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("heading", { name: "Review the dashboard plan" }),
  ).toBeVisible();
  const header = page.locator("header").filter({ has: breadcrumb });
  await expect(
    header.getByText("Idle").filter({ visible: true }),
  ).toBeVisible();
  await screenshot(page, "conversation-task-page");
});
