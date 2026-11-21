import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  openRepositoryConversations,
  pinFirstRepositoryConversation,
} from "../repositoryConversations";
import { expect, test } from "../test";
import { screenshot } from "../screenshot";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("shows code activity", async ({ page, dashboard }) => {
    await page.goto(`${dashboard.baseURL}/code`);

    await expect(
      page
        .getByRole("main")
        .getByRole("heading", { name: "Code", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Repositories and code changes created by Junior."),
    ).toBeVisible();
    // Draft only shows on open changes; a merged change shows Merged.
    const recentChanges = page.locator("section", {
      hasText: "Recent changes",
    });
    await expect(recentChanges.getByText(/^draft$/i)).toHaveCount(1);
    await expect(recentChanges.getByText(/^merged$/i)).toHaveCount(1);
    await screenshot(page, "code");

    await page
      .getByRole("link", { name: "getsentry/junior", exact: true })
      .click();

    await expect(
      page.getByRole("heading", { name: "getsentry/junior", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle(/^\(\d+\) getsentry\/junior - Junior$/);
    await expect(
      page.getByRole("link", { name: "junior", exact: true }),
    ).toHaveAttribute("href", "/system/workspaces/workspace-junior");
    await expect(
      page.getByText("Keep repository context across turns"),
    ).toBeVisible();
    await screenshot(page, "code-repository");

    await page
      .getByRole("navigation", { name: "Repository navigation" })
      .getByRole("link", { name: "Changes" })
      .click();
    await expect(page).toHaveURL(/\/code\/[^/]+\/changes$/);
    await expect(page.getByRole("tab", { name: /Merged/ })).toBeVisible();
  });

  test("counts every open code change past the listed ones", async ({
    page,
    dashboard,
  }) => {
    // The reports list at most 100 changes. The counts cover every change.
    await page.route(/\/api\/people\/[^/]+\/code$/, async (route) => {
      const response = await route.fetch();
      const report = await response.json();
      await route.fulfill({
        response,
        json: {
          ...report,
          // Every listed change is active. The one idle change is past the
          // limit, so only the summary counts it.
          changes: Array.from({ length: 100 }, (_, index) => ({
            ...report.changes[0],
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            lastActivityAt: report.generatedAt,
            number: index + 1,
            state: "open",
          })),
          summary: { ...report.summary, idle: 1, open: 105 },
        },
      });
    });
    // The open changes fill the list, so the Closed tab loads its own rows.
    await page.route(/\/api\/code\/repositories\/[^/]+$/, async (route) => {
      const response = await route.fetch();
      const report = await response.json();
      const state = new URL(route.request().url()).searchParams.get("state");
      const changes = (count: number, changeState: string, title: string) =>
        Array.from({ length: count }, (_, index) => ({
          draft: false,
          id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
          number: index + 1,
          openedAt: report.generatedAt,
          provider: "github",
          repository: report.repository.name,
          state: changeState,
          title: `${title} ${index + 1}`,
          url: `https://github.com/${report.repository.name}/pull/${index + 1}`,
        }));
      await route.fulfill({
        response,
        json: {
          ...report,
          changeCounts: { closed: 12, merged: 3, open: 105 },
          changes:
            state === "closed"
              ? changes(12, "closed", "Closed change")
              : changes(100, "open", "Open change"),
        },
      });
    });

    await page.goto(`${dashboard.baseURL}/conversations/new`);
    const week = page.getByRole("region", { name: "Your week" });
    await expect(week.getByText("105", { exact: true })).toBeVisible();
    await expect(week.getByText("1 idle 7d+")).toBeVisible();
    await expect(week.getByText("all moving")).toHaveCount(0);
    // The Inbox's own word names what waits on the viewer.
    await expect(week.getByText("To do", { exact: true })).toBeVisible();
    await expect(week.getByText("Needs you")).toHaveCount(0);

    await page.goto(`${dashboard.baseURL}/code`);
    await page
      .getByRole("link", { name: "getsentry/junior", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Repository navigation" })
      .getByRole("link", { name: "Changes" })
      .click();
    await expect(page.getByRole("tab", { name: /^All/ })).toContainText("120");
    await expect(page.getByRole("tab", { name: /^Open/ })).toContainText("105");
    await page.getByRole("tab", { name: /^Closed/ }).click();
    await expect(
      page.getByRole("link", { name: "Closed change 12" }),
    ).toBeVisible();
    await expect(page.getByText("No changes match this state.")).toHaveCount(0);
  });

  test("opens Linked work toward the larger free space", async ({
    page,
    dashboard,
  }) => {
    // Some browsers default to a root font smaller than 16px. Set it before
    // the page loads: a later change animates the sidebar width while the
    // hover runs. The first repository conversation sits about 450px from the
    // top.
    await page.addInitScript(() => {
      // The document has no elements yet, so adopt a sheet instead of a tag.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("html { font-size: 14px }");
      document.adoptedStyleSheets = [sheet];
    });
    for (const { height, side } of [
      { height: 1400, side: "bottom" },
      { height: 600, side: "top" },
    ]) {
      await page.setViewportSize({ height, width: 1600 });
      // Open the page directly so it starts at the top. A click from the
      // scrolled Code list can keep that scroll, and a root font change after
      // render moves the row while the hover runs. Both move the trigger up.
      await page.goto(
        `${dashboard.baseURL}/code/00000000-0000-4000-8000-000000000003`,
      );
      await page
        .getByLabel(/^Linked work, newest first/)
        .first()
        .hover();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toContainText("Linked work");
      await expect(tooltip).toHaveAttribute("data-side", side);
    }
  });

  test("counts every change in the state tabs and loads each state", async ({
    page,
    dashboard,
  }) => {
    const day = 86_400_000;
    const states: (string | null)[] = [];
    await page.route("**/api/code/repositories/*", async (route) => {
      const state = new URL(route.request().url()).searchParams.get("state");
      states.push(state);
      const response = await route.fetch();
      const report = await response.json();
      const idleChange = {
        draft: false,
        id: "00000000-0000-4000-8000-000000000099",
        lastActivityAt: new Date(NOW_MS - 10 * day).toISOString(),
        number: 990,
        openedAt: new Date(NOW_MS - 12 * day).toISOString(),
        provider: "github",
        repository: "getsentry/junior",
        state: "open",
        title: "Retry Slack uploads after a rate limit",
      };
      await route.fulfill({
        json: {
          ...report,
          // The report lists only some changes; the counts cover all of them.
          changeCounts: { closed: 2, merged: 40, open: 3 },
          changes: state === "open" ? [idleChange] : report.changes,
        },
        response,
      });
    });
    await page.goto(`${dashboard.baseURL}/code`);
    await page
      .getByRole("link", { name: "getsentry/junior", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Repository navigation" })
      .getByRole("link", { name: "Changes" })
      .click();

    const tabs = page.getByRole("tablist", { name: "Change state" });
    await expect(tabs.getByRole("tab", { name: "All 45" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Merged 40" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Closed 2" })).toBeVisible();

    await tabs.getByRole("tab", { name: "Open 3" }).click();
    const changes = page.getByRole("region", { name: "Changes" });
    await expect(
      changes.getByText("Retry Slack uploads after a rate limit"),
    ).toBeVisible();
    await expect(
      changes.getByText("Keep repository context across turns"),
    ).toHaveCount(0);
    expect(states).toContain("open");
    // The open change shows how long it has been idle.
    await changes.getByText("10d", { exact: true }).hover();
    await expect(
      page.getByText("Last activity 10d ago · opened 12d ago"),
    ).toBeVisible();
  });

  test("the repository Conversations tab keeps a pin in place, and Pinned only lists only the pins", async ({
    page,
    dashboard,
  }) => {
    await pinFirstRepositoryConversation(page);
    const list = await openRepositoryConversations(page, dashboard.baseURL);
    const pinned = list.getByRole("link", { name: "Open Pinned conversation" });
    const unpinned = list.getByRole("link", {
      name: "Open Unpinned conversation",
    });
    await expect(pinned).toBeVisible();
    await expect(unpinned).toBeVisible();
    await expect(list.getByRole("region", { name: /^Pinned/ })).toHaveCount(0);
    // Only the pin has the pin marker.
    await expect(list.getByRole("img", { name: "Pinned" })).toHaveCount(1);

    const pinnedOnly = list
      .getByRole("navigation", { name: "Rows to show" })
      .getByRole("link", { name: "Pinned only" });
    await pinnedOnly.click();
    await expect(page).toHaveURL(/\/conversations\?pinned=1$/);
    await expect(pinned).toBeVisible();
    await expect(unpinned).toHaveCount(0);
    await page.reload();
    await expect(pinnedOnly).toHaveAttribute("aria-current", "page");
    await expect(pinned).toBeVisible();
    await expect(unpinned).toHaveCount(0);

    await pinnedOnly.click();
    await expect(unpinned).toBeVisible();
  });

  test("the repository Conversations tab says how to pin when Pinned only finds no pin", async ({
    page,
    dashboard,
  }) => {
    const list = await openRepositoryConversations(page, dashboard.baseURL);
    await expect(
      list.getByRole("link", { name: /^Open / }).first(),
    ).toBeVisible();
    await list
      .getByRole("navigation", { name: "Rows to show" })
      .getByRole("link", { name: "Pinned only" })
      .click();
    await expect(list.getByText(/^Nothing pinned\./)).toBeVisible();
    await expect(list.getByRole("link", { name: /^Open / })).toHaveCount(0);
  });

  test("the repository Conversations tab filters by state, also after a reload", async ({
    page,
    dashboard,
  }) => {
    await page.route(
      /\/api\/conversations\?.*codeRepositoryId=/,
      async (route) => {
        const response = await route.fetch();
        const feed = await response.json();
        const [first] = feed.conversations;
        const listed = (name: string, treeState: string) => ({
          ...first,
          conversationId: `${first.conversationId}-${treeState}`,
          displayTitle: name,
          pinnedAt: null,
          treeState,
        });
        return route.fulfill({
          response,
          json: {
            ...feed,
            conversations: [
              listed("Working conversation", "working"),
              listed("Done conversation", "done"),
            ],
          },
        });
      },
    );
    const list = await openRepositoryConversations(page, dashboard.baseURL);
    const working = list.getByRole("link", {
      name: "Open Working conversation",
    });
    const done = list.getByRole("link", { name: "Open Done conversation" });
    await expect(working).toBeVisible();
    await expect(done).toBeVisible();

    const filters = list.getByRole("navigation", {
      name: "Conversations to show",
    });
    await filters.getByRole("link", { name: "Working" }).click();
    await expect(page).toHaveURL(/\/conversations\?state=working$/);
    await expect(working).toBeVisible();
    await expect(done).toHaveCount(0);
    await page.reload();
    await expect(
      filters.getByRole("link", { name: "Working" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(working).toBeVisible();
    await expect(done).toHaveCount(0);

    await filters.getByRole("link", { name: "Done" }).click();
    await expect(done).toBeVisible();
    await expect(working).toHaveCount(0);
    await filters.getByRole("link", { name: "Watching" }).click();
    await expect(
      list.getByText("No conversations match these filters."),
    ).toBeVisible();
    await filters.getByRole("link", { name: "All" }).click();
    await expect(page).not.toHaveURL(/[?&]state=/);
    await expect(working).toBeVisible();
    await expect(done).toBeVisible();
  });
});
