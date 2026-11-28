import type { Locator, Page, Request } from "@playwright/test";
import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";
import { waitForOutlineRead } from "../harness";
import { mockFeedPage } from "../mock-reports";

test.describe("new UI", () => {
  const ROOT_ID = "internal:dashboard-qa";
  const THREAD_ID = "junior:internal:dashboard-qa:thread";
  const NESTED_THREAD_ID = "junior:internal:dashboard-qa:thread:nested";
  const TASK_ID = "junior:internal:dashboard-qa:advisor-plan";
  const BLOCKED_TASK_ID = "junior:internal:dashboard-qa:advisor-review";
  const ARCHIVED_THREAD_ID = "junior:internal:dashboard-qa:archived-thread";

  /** The Conversations bundle, which nests each Thread under its parent. */
  function conversationsList(page: Page) {
    return page.getByRole("region", { exact: true, name: "Conversations" });
  }

  /** Open the Conversations bundle from the Inbox entries, in the app. */
  async function openConversations(page: Page) {
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { exact: true, name: "Conversations" })
      .click();
  }

  test("shows Threads under their parent and in details", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const list = conversationsList(page);
    // An archived Thread drops out of the list.
    await expect(
      list.getByRole("link", { name: /Compare sidebar badges/ }),
    ).toHaveCount(0);

    // A Thread under a Thread follows its parent row. The indent is left to
    // visual QA.
    const threadRow = list.getByRole("link", {
      name: /Check pinned row order/,
    });
    await expect(threadRow).toBeVisible();
    const rowNames = await list.getByRole("link").allTextContents();
    const parentIndex = rowNames.findIndex((name) =>
      name.includes("Check pinned row order"),
    );
    expect(parentIndex).toBeGreaterThan(-1);
    expect(rowNames[parentIndex + 1]).toContain("Recheck pin order in Safari");

    // A Thread opens its own page, and details link its parent.
    await threadRow.click();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`,
    );
    const details = page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    await details
      .getByRole("link", { name: "Dashboard QA edge cases" })
      .click();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(ROOT_ID)}`,
    );

    // An archived Thread is finished, so it waits behind "Show finished".
    const work = details.getByRole("region", { exact: true, name: "Agents" });
    const archived = work.getByRole("link", { name: /Compare sidebar badges/ });
    await expect(archived).toHaveCount(0);
    await work.getByRole("button", { name: "Show finished" }).click();
    await expect(archived.getByRole("img", { name: "Done" })).toBeVisible();
    await work.getByRole("button", { name: "Hide finished" }).click();
    await expect(archived).toHaveCount(0);
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
    const held: Request[] = [];
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
      held.push(route.request());
      await released;
      await route.continue();
    });
    return {
      calls,
      /** Let calls through and wait for the response of each call so far. */
      release: async () => {
        release?.();
        await Promise.all(held.map((request) => request.response()));
      },
    };
  }

  test("archives a Thread from its page", async ({ page, dashboard }) => {
    const { calls: archiveCalls, release: releaseArchive } =
      await holdArchives(page);
    const threadUrl = `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`;
    const threadArchiveUrl = `${dashboard.baseURL}/api/conversations/${encodeURIComponent(THREAD_ID)}/archive`;
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const list = conversationsList(page);
    const threadRow = list.getByRole("link", {
      name: /Check pinned row order/,
    });
    const nestedRow = list.getByRole("link", {
      name: /Recheck pin order in Safari/,
    });
    const rootRow = list.getByRole("link", {
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
    await threadRow.click();
    await expect(page).toHaveURL(threadUrl);

    // A Thread archive is for everyone and takes its nested Thread with it, so
    // it asks first. The page goes back to its list like any archive.
    await openMenu.click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(openMenus).toHaveCount(0);
    await page
      .getByRole("alertdialog", {
        name: "Also archive its child conversations?",
      })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/inbox?view=conversations`,
    );
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
    await releaseArchive();
    await expect(rootRow).toBeVisible();

    // An archived Thread stays readable, and Restore brings its row back.
    await page.goto(threadUrl);
    await openMenu.click();
    await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
    await expect(openMenus).toHaveCount(0);
    // The direct link has no origin, so Back goes to Conversations.
    await page.getByRole("link", { name: "Back to Conversations" }).click();
    await openConversations(page);
    await expect(threadRow).toBeVisible();
    await expect(nestedRow).toBeVisible();
    await expect
      .poll(() => archiveCalls)
      .toEqual([
        { applyToChildren: true, archived: true, url: threadArchiveUrl },
        { applyToChildren: true, archived: false, url: threadArchiveUrl },
      ]);
    await releaseArchive();
  });

  test("archives a nested Thread without its parent", async ({
    page,
    dashboard,
  }) => {
    const archive = await holdArchives(page);
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const list = conversationsList(page);
    const threadRow = list.getByRole("link", {
      name: /Check pinned row order/,
    });
    const nestedRow = list.getByRole("link", {
      name: /Recheck pin order in Safari/,
    });
    await nestedRow.click();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(NESTED_THREAD_ID)}`,
    );

    await page
      .getByRole("button", { name: "Conversation menu", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Archive for everyone?" })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect.poll(() => archive.calls.length).toBe(1);
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/inbox?view=conversations`,
    );
    // The nested row hides at once. Its parent Thread stays.
    await expect(nestedRow).toHaveCount(0);
    await expect(threadRow).toBeVisible();
    await archive.release();

    // Undo puts the nested row back under its parent before the restore
    // settles, so it does not wait on a feed refetch.
    const restore = await holdArchives(page);
    await page
      .getByRole("button", { name: /Undo archive for Recheck pin order/ })
      .click();
    await expect.poll(() => restore.calls.length).toBe(1);
    await expect(nestedRow).toBeVisible();
    const rowNames = await list.getByRole("link").allTextContents();
    const parentIndex = rowNames.findIndex((name) =>
      name.includes("Check pinned row order"),
    );
    expect(rowNames[parentIndex + 1]).toContain("Recheck pin order in Safari");
    await restore.release();
  });

  test("archives a Thread from its list row", async ({ page, dashboard }) => {
    const archive = await holdArchives(page);
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const list = conversationsList(page);
    const threadRow = list.getByRole("link", {
      name: /Check pinned row order/,
    });
    const nestedRow = list.getByRole("link", {
      name: /Recheck pin order in Safari/,
    });

    // The row action shows on hover. It asks first, like the Thread page.
    await threadRow.hover();
    await list
      .getByRole("button", { name: "Archive Check pinned row order" })
      .click();
    await page
      .getByRole("alertdialog", {
        name: "Also archive its child conversations?",
      })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect
      .poll(() => archive.calls)
      .toEqual([
        {
          applyToChildren: true,
          archived: true,
          url: `${dashboard.baseURL}/api/conversations/${encodeURIComponent(THREAD_ID)}/archive`,
        },
      ]);
    await expect(threadRow).toHaveCount(0);
    await expect(nestedRow).toHaveCount(0);
    // The list stays open.
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/inbox?view=conversations`,
    );
    await archive.release();
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

  test("links Threads and shows Tasks as chips in the parent transcript", async ({
    page,
    dashboard,
  }) => {
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
    await expect(threadCard).toContainText("Done");
    // The feed leaves out an archived Thread, so its card shows the status
    // that the parent recorded.
    const archivedCard = transcript.getByRole("link", {
      name: /Compare sidebar badges/,
    });
    await expect(archivedCard).toHaveAttribute(
      "href",
      `/conversations/${encodeURIComponent(ARCHIVED_THREAD_ID)}`,
    );
    await expect(archivedCard).toContainText("Done");

    // Each Task is a chip under the reply. A chip opens the drawer.
    await screenshot(page, "conversation-task-line");
    const chip = transcript.getByRole("button", {
      name: /^Open Review the dashboard plan transcript/,
    });
    const drawer = page.getByRole("dialog", {
      name: "Review the dashboard plan",
    });
    const details = page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    // A held Esc closes only the drawer. Its repeats leave Details open.
    // Opening and closing the drawer again proves the repeats were handled.
    await expect(details).toBeVisible();
    await holdEscapeOverDrawer(chip, drawer);
    await chip.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(details).toBeVisible();

    // A message to a child agent and the child's message back show as a
    // pair of rows that link the child.
    const sent = transcript.getByRole("group", {
      name: "Message to Review the dashboard plan",
    });
    const received = transcript.getByRole("group", {
      name: "Message from Review the dashboard plan",
    });
    await expect(sent).toContainText("Delivered");
    await expect(sent).toContainText("after a hard reload");
    await expect(
      sent.getByRole("link", { name: "Review the dashboard plan" }),
    ).toHaveAttribute("href", `/conversations/${encodeURIComponent(TASK_ID)}`);
    await expect(received).toContainText("keeps the order");
    await expect(received).not.toContainText("agent-message");
    // A child agent without a title shows by the name that `to` used.
    await expect(
      transcript.getByRole("group", { name: "Message to reviewer" }),
    ).toContainText("Delivered");
    // No agent got a refused message, so it names the target it used and
    // says why.
    const refused = transcript.getByRole("group", {
      name: "Message to designer",
    });
    await expect(refused).toContainText("Refused");
    // Only the words meant for a person show. The row names the target.
    await expect(
      refused.getByText(
        'Not "parent", a child agent of this conversation, or a top-level agent that you can message.',
        { exact: true },
      ),
    ).toBeVisible();
    // The viewer started this private Conversation and is no longer a
    // Participant, so the dock says how to get back in.
    await expect(
      page.getByText("You left. A participant can invite you back."),
    ).toBeVisible();
    await sent.scrollIntoViewIfNeeded();
    await screenshot(page, "conversation-agent-messages", { lightTheme: true });

    await archivedCard.scrollIntoViewIfNeeded();
    await screenshot(page, "conversation-thread-cards", { view: "desktop" });
    await page.setViewportSize({ height: 844, width: 390 });
    await archivedCard.scrollIntoViewIfNeeded();
    await screenshot(page, "conversation-thread-cards", { view: "mobile" });
    await page.setViewportSize({ height: 900, width: 1440 });
    // Each visit reads the outline of its Conversation.
    const outlineRead = waitForOutlineRead(page, THREAD_ID);
    await threadCard.click();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`,
    );
    await outlineRead;
  });

  test("a held Esc with Details closed stays on the page", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(ROOT_ID)}`,
    );
    const transcript = page.getByLabel("Conversation transcript");
    const details = page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    await expect(details).toBeVisible();
    await page
      .getByRole("button", { name: "Close conversation details" })
      .click();
    await expect(details).toBeHidden();
    const chip = transcript.getByRole("button", {
      name: /^Open Review the dashboard plan transcript/,
    });
    const drawer = page.getByRole("dialog", {
      name: "Review the dashboard plan",
    });
    await holdEscapeOverDrawer(chip, drawer);
    // The repeats do not go back to the list: the chip still opens it.
    await chip.click();
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(ROOT_ID)}`,
    );
  });

  test("shows the breadcrumb, status, and Turn authors of a Thread", async ({
    page,
    dashboard,
  }) => {
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
    // The pill shows the status that the API derives from runtime state.
    const header = page.locator("header").filter({ has: breadcrumb });
    await expect(
      header.getByText("Done").filter({ visible: true }),
    ).toBeVisible();

    // The parent agent started the first Turn; a person started the next.
    const transcript = page.getByLabel("Conversation transcript");
    await expect(
      transcript.getByRole("group", {
        name: "Message from Dashboard QA edge cases",
      }),
    ).toBeVisible();
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
    // It has no open question, so it does not need input.
    await expect(
      header.getByText("Done").filter({ visible: true }),
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
      header.getByText("Done").filter({ visible: true }),
    ).toBeVisible();
    await screenshot(page, "conversation-task-page");

    // A blocked Task is done with its work. Its parent's report says how
    // its last Turn ended.
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(BLOCKED_TASK_ID)}`,
    );
    await expect(
      breadcrumb.getByRole("heading", { name: "reviewer" }),
    ).toBeVisible();
    await expect(
      header.getByText("Blocked").filter({ visible: true }),
    ).toBeVisible();
  });

  test("a running row that needs input shows both", async ({
    page,
    dashboard,
  }) => {
    // An open action item reads `needs_input` while a Turn runs.
    await page.route(
      (url) => url.pathname === "/api/conversations",
      async (route) => {
        const feed = await mockFeedPage(route);
        await route.fulfill({
          json: {
            ...feed,
            conversations: feed.conversations.map(
              (row: { conversationId: string }) =>
                row.conversationId === ROOT_ID
                  ? { ...row, status: "needs_input", turnActive: true }
                  : row,
            ),
          },
        });
      },
    );
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);

    const row = page
      .getByRole("region", { exact: true, name: "Conversations" })
      .getByRole("listitem")
      .filter({
        has: page.getByRole("link", { name: /Dashboard QA edge cases/ }),
      });
    await expect(row.getByText("Needs input")).toBeVisible();
    await expect(row.getByRole("status", { name: "Working" })).toBeVisible();
  });
});

/** Open the drawer, then hold Esc over it: one press, then two repeats. */
async function holdEscapeOverDrawer(chip: Locator, drawer: Locator) {
  await chip.click();
  await expect(drawer).toBeVisible();
  const keyboard = chip.page().keyboard;
  await keyboard.down("Escape");
  await expect(drawer).toBeHidden();
  await keyboard.down("Escape");
  await keyboard.down("Escape");
  await keyboard.up("Escape");
}
