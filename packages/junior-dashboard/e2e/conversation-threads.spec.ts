import { expect, test } from "./test";

const ROOT_ID = "internal:dashboard-qa";
const THREAD_ID = "junior:internal:dashboard-qa:thread";
const TASK_ID = "junior:internal:dashboard-qa:advisor-plan";

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

  // A Thread opens its own page, and its sidebar row is the current page.
  const threadRow = sidebar.getByRole("link", {
    name: /Check pinned row order/,
  });
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

test("archives a Thread from its page", async ({ page, dashboard }) => {
  const archiveCalls: Array<{
    applyToChildren?: boolean;
    archived: boolean;
    url: string;
  }> = [];
  let releaseArchive: (() => void) | undefined;
  const archiveReleased = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  await page.route("**/api/conversations/*/archive", async (route) => {
    const body = route.request().postDataJSON() as {
      applyToChildren?: boolean;
      archived: boolean;
    };
    archiveCalls.push({
      applyToChildren: body.applyToChildren,
      archived: body.archived,
      url: route.request().url(),
    });
    await archiveReleased;
    await route.continue();
  });
  const threadUrl = `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`;
  const threadArchiveUrl = `${dashboard.baseURL}/api/conversations/${encodeURIComponent(THREAD_ID)}/archive`;
  await page.goto(threadUrl);
  const sidebar = page.getByRole("navigation", { name: "Your conversations" });
  const threadRow = sidebar.getByRole("link", {
    name: /Check pinned row order/,
  });
  const rootRow = sidebar.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  const openMenu = page.getByRole("button", {
    name: "Conversation menu",
    exact: true,
  });
  await expect(threadRow).toBeVisible();

  // A Thread archive is for everyone, so it asks first. It hides only the
  // Thread, and the page goes home like any archive.
  await openMenu.click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close conversation menu" }),
  ).toHaveCount(0);
  await page
    .getByRole("alertdialog", { name: "Archive for everyone?" })
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page).toHaveURL(new URL("/", dashboard.baseURL).href);
  await expect
    .poll(() => archiveCalls)
    .toEqual([
      { applyToChildren: true, archived: true, url: threadArchiveUrl },
    ]);
  // The row hides while the archive is still in flight, so the feed update
  // is the optimistic one, not a refetch.
  await expect(threadRow).toHaveCount(0);
  releaseArchive?.();
  await expect(rootRow).toBeVisible();

  // An archived Thread stays readable, and Unarchive brings its row back.
  await page.goto(threadUrl);
  await openMenu.click();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(threadRow).toBeVisible();
  await expect
    .poll(() => archiveCalls)
    .toEqual([
      { applyToChildren: true, archived: true, url: threadArchiveUrl },
      { applyToChildren: true, archived: false, url: threadArchiveUrl },
    ]);
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
