import type { Page } from "@playwright/test";
import { NOW_MS } from "../../src/mock-reporting/fixtures";
import {
  openRepositoryConversations,
  pinFirstRepositoryConversation,
} from "../repositoryConversations";
import {
  mockInboxItems,
  mockViewerCodeChanges,
  prReview,
} from "./inbox-fixture";
import { expect, test } from "../test";
import { desktop, screenshot } from "../screenshot";
import {
  mockCodeRepository,
  mockFeedPage,
  mockPeopleCode,
} from "../mock-reports";

test.describe("new UI", () => {
  test("the Code row opens Mine, and stays the origin of a Conversation that Code opens", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(dashboard.baseURL);
    const primary = page.getByRole("navigation", { name: "Primary" });
    const code = primary.getByRole("link", { exact: true, name: "Code" });
    await code.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/code`);
    await expect(code).toHaveAttribute("aria-current", "page");
    const scopes = page.getByRole("navigation", { name: "Code to show" });
    await expect(
      scopes.getByRole("link", { exact: true, name: "Mine" }),
    ).toHaveAttribute("aria-current", "page");

    // A Conversation opened from a repository keeps Code as its origin.
    const list = await openRepositoryConversations(page, dashboard.baseURL);
    await expect(code).toHaveAttribute("aria-current", "page");
    await list
      .getByRole("link", { name: /^Open / })
      .first()
      .click();
    await expect(page).toHaveURL(/\/conversations\//);
    await expect(code).toHaveAttribute("aria-current", "true");
    await page.getByRole("link", { name: "Back to Code" }).click();
    await expect(page).toHaveURL(/\/code\/[^/]+\/conversations$/);
  });

  test("Code · All lists every repository first, then every stat and the activity chart", async ({
    page,
    dashboard,
  }) => {
    await page.goto(`${dashboard.baseURL}/code`);
    await page
      .getByRole("navigation", { name: "Code to show" })
      .getByRole("link", { exact: true, name: "All" })
      .click();
    await expect(page).toHaveURL(/\/code\?scope=all$/);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Code", exact: true }),
    ).toBeVisible();
    await expect(
      main.getByRole("table").getByRole("link", { name: "getsentry/junior" }),
    ).toBeVisible();
    // The table comes first. The summary cards, the chart, and the newest
    // changes follow it.
    await expect(main).toContainText(
      /Repositories[\s\S]*Median merge time[\s\S]*Cost[\s\S]*Changes over time[\s\S]*Recent changes/,
    );
    await expect(main).toContainText(
      "Repositories and code changes created by Junior.",
    );
    // The chart card holds its own range.
    await main
      .getByRole("group", { name: "Reporting period" })
      .getByRole("button", { name: "7d" })
      .click();
    await expect(
      main.getByRole("img", { name: "Code changes during the last 7 days" }),
    ).toBeVisible();
    // Draft only shows on open changes.
    await expect(main).toContainText(/Recent changes[\s\S]*draft/i);
    await screenshot(page, "code");

    await main
      .getByRole("link", { name: "getsentry/junior", exact: true })
      .click();

    await expect(
      main.getByRole("heading", { name: "getsentry/junior", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle(/^\(\d+\) getsentry\/junior - Junior$/);
    await expect(
      page.getByRole("link", { name: "junior", exact: true }),
    ).toHaveAttribute("href", "/system/workspaces/workspace-junior");
    await expect(
      main.getByRole("link", { name: /Keep repository context across turns/ }),
    ).toBeVisible();
    await screenshot(page, "code-repository");

    const tabs = page.getByRole("navigation", {
      name: "Repository navigation",
    });
    await expect(tabs.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await tabs.getByRole("link", { name: "Changes" }).click();
    await expect(page).toHaveURL(/\/code\/[^/]+\/changes$/);
    await expect(page.getByRole("tab", { name: /Merged/ })).toBeVisible();
    // The Changes tab has no chart of its own.
    await expect(
      main.getByRole("img", { name: /^Code changes during/ }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Back to Code" }).click();
    await expect(page).toHaveURL(/\/code\?scope=all$/);
  });

  test("Code · Mine sorts your open changes into Waiting on you, Waiting on others and Drafts", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [prReview] });
    await mockViewerCodeChanges(page, [
      {
        idleDays: 0,
        number: 7,
        size: { additions: 1204, changedFiles: 12, deletions: 340 },
        title: "Tune the retry backoff",
      },
      // GitHub counted no deletions here.
      {
        idleDays: 10,
        number: 8,
        size: { additions: 64, changedFiles: 2 },
        title: "Drop the legacy webhook",
      },
      // prReview asks the viewer to review this one.
      { idleDays: 1, number: 91, title: "Pin the release train" },
      { draft: true, idleDays: 0, number: 15, title: "Sketch the replay" },
      {
        idleDays: 0,
        number: 9,
        state: "merged",
        title: "Rename the payments queue",
      },
    ]);
    await page.goto(`${dashboard.baseURL}/code`);
    const mine = page.getByRole("region", { exact: true, name: "Code" });
    await expect(mine.getByRole("region")).toHaveText([
      /^Waiting on you/,
      /^Waiting on others/,
      /^Drafts/,
    ]);
    const waiting = mine
      .getByRole("region", { name: "Waiting on you" })
      .getByRole("listitem", { name: "Pin the release train" });
    await expect(
      waiting.getByRole("link", { exact: true, name: "Pin the release train" }),
    ).toHaveAttribute("href", "https://github.com/getsentry/payments/pull/91");
    // The rest wait on a reviewer, CI or Junior: newest activity first, so
    // the idle one comes last.
    const others = mine.getByRole("region", { name: "Waiting on others" });
    await expect(others.getByRole("listitem")).toHaveText([
      /Tune the retry backoff/,
      /Drop the legacy webhook/,
    ]);
    // Each row gives its size, and leaves out a count it does not know.
    await expect(
      others.getByRole("listitem", { name: "Tune the retry backoff" }),
    ).toContainText("1,204 lines added, 340 removed, 12 files changed");
    const legacy = others.getByRole("listitem", {
      name: "Drop the legacy webhook",
    });
    await expect(legacy).toContainText("64 lines added, 2 files changed");
    await expect(legacy).not.toContainText("removed");
    await expect(
      mine.getByRole("listitem", { name: "Rename the payments queue" }),
    ).toHaveCount(0);
    // A draft waits on its author, so it leaves the other piles. Drafts starts
    // collapsed.
    const drafts = mine.getByRole("region", { name: "Drafts" });
    await expect(drafts.getByRole("listitem")).toHaveCount(0);
    await drafts.getByRole("button", { name: /Drafts/ }).click();
    await expect(drafts.getByRole("listitem")).toHaveText([
      /Sketch the replay/,
    ]);
    // The viewer's own numbers follow the list.
    await expect(
      mine.getByRole("img", { name: /^Code changes during the last 30 days/ }),
    ).toBeVisible();

    // The ask stays with its pull request, and opens its row in the Inbox.
    // The Inbox drops `item` from the URL once the row shows, so the link
    // and the open row prove it, not the URL in between.
    const ask = waiting.getByRole("link", { name: /^Review requested/ });
    await expect(ask).toHaveAttribute(
      "href",
      `/inbox?view=inbox&item=${encodeURIComponent(prReview.id)}`,
    );
    await ask.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/inbox?view=inbox`);
    await expect(
      page.getByRole("region", { name: `${prReview.title}: asks` }),
    ).toBeVisible();
  });

  test("Code · Mine stacks the changes of one Conversation or Automation in their group", async ({
    dashboard,
    page,
  }) => {
    const flakyDeploy = {
      id: "slack:C1:1770000000.000100",
      kind: "conversation" as const,
      title: "Fix the flaky deploy",
    };
    const releaseTrain = {
      id: "scheduled-3",
      kind: "automation" as const,
      title: "Release train",
    };
    await mockViewerCodeChanges(page, [
      {
        idleDays: 0,
        number: 7,
        stack: flakyDeploy,
        title: "Tune the retry backoff",
      },
      { idleDays: 1, number: 8, title: "Drop the legacy webhook" },
      {
        idleDays: 2,
        number: 9,
        stack: flakyDeploy,
        title: "Retry the deploy check",
      },
      { idleDays: 3, number: 10, stack: releaseTrain, title: "Bump zod" },
      {
        draft: true,
        idleDays: 0,
        number: 11,
        stack: releaseTrain,
        title: "Bump vitest",
      },
    ]);
    await page.goto(`${dashboard.baseURL}/code`);
    const others = page
      .getByRole("region", { exact: true, name: "Code" })
      .getByRole("region", { name: "Waiting on others" });
    // The stack takes the place of its first change, so the group keeps its
    // order.
    const stack = others.getByRole("listitem", { name: flakyDeploy.title });
    await expect(stack.getByRole("listitem")).toHaveText([
      /Tune the retry backoff/,
      /Retry the deploy check/,
    ]);
    await expect(others).toContainText(
      /Fix the flaky deploy[\s\S]*Retry the deploy check[\s\S]*Drop the legacy webhook[\s\S]*Bump zod/,
    );
    await expect(
      stack.getByRole("link", { exact: true, name: flakyDeploy.title }),
    ).toHaveAttribute(
      "href",
      `/conversations/${encodeURIComponent(flakyDeploy.id)}`,
    );
    // A source stacks only within one group: its draft sits in Drafts, so
    // its other change stays a plain row.
    await expect(
      others.getByRole("listitem", { name: releaseTrain.title }),
    ).toHaveCount(0);
    await expect(
      others.getByRole("listitem", { name: "Bump zod" }),
    ).toBeVisible();
    await screenshot(page, "code-mine-stacks", { lightTheme: true });
  });

  test("Code · Mine waits for your asks before it groups your changes, and says when they fail", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [prReview] });
    await mockViewerCodeChanges(page, [
      { idleDays: 1, number: 91, title: "Pin the release train" },
    ]);
    // Hold the asks, so only the changes have loaded.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/inbox-items?**", async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`${dashboard.baseURL}/code`);
    const mine = page.getByRole("region", { exact: true, name: "Code" });
    await expect(mine.getByRole("status")).toHaveText(
      "Loading your pull requests",
    );
    await expect(mine.getByRole("region")).toHaveCount(0);
    release();
    // The change waits on the viewer, because its ask names it.
    await expect(
      mine
        .getByRole("region", { name: "Waiting on you" })
        .getByRole("listitem", { name: "Pin the release train" }),
    ).toBeVisible();
    await expect(
      mine.getByRole("region", { name: "Waiting on others" }),
    ).toHaveCount(0);

    await page.unroute("**/api/inbox-items?**");
    await page.route("**/api/inbox-items?**", (route) =>
      route.fulfill({ json: { error: "unavailable" }, status: 503 }),
    );
    await page.reload();
    await expect(
      mine.getByRole("alert").filter({ hasText: "Could not load your asks." }),
    ).toBeVisible();
    await expect(mine.getByRole("region")).toHaveCount(0);
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { height: 844, width: 390 } });

    test("the header holds the way back, the title, and Mine · All", async ({
      page,
      dashboard,
    }) => {
      await page.goto(`${dashboard.baseURL}/inbox`);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { exact: true, name: "Code" })
        .click();
      await expect(page).toHaveURL(`${dashboard.baseURL}/code`);
      // The phone header holds the title and the scope tabs, as an Inbox
      // list holds its filters. The page body has neither.
      const header = page.getByRole("main");
      const body = header.getByRole("region", { exact: true, name: "Code" });
      const scopes = header.getByRole("navigation", { name: "Code to show" });
      await expect(
        header.getByRole("heading", { exact: true, name: "Code" }),
      ).toBeVisible();
      await expect(scopes).toBeVisible();
      await expect(
        body.getByRole("heading", { exact: true, name: "Code" }),
      ).toHaveCount(0);
      await expect(
        body.getByRole("navigation", { name: "Code to show" }),
      ).toHaveCount(0);
      await expect(
        scopes.getByRole("link", { exact: true, name: "Mine" }),
      ).toHaveAttribute("aria-current", "page");
      await scopes.getByRole("link", { exact: true, name: "All" }).click();
      await expect(page).toHaveURL(/\/code\?scope=all$/);
      // The repository table leads the page body.
      await page
        .getByRole("main")
        .getByRole("link", { name: "getsentry/junior", exact: true })
        .click();
      await expect(
        header.getByRole("heading", { exact: true, name: "getsentry/junior" }),
      ).toBeVisible();
      await expect(
        header.getByRole("navigation", { name: "Repository navigation" }),
      ).toBeVisible();
      await header.getByRole("link", { name: "Back to Code" }).click();
      await expect(page).toHaveURL(/\/code\?scope=all$/);
      await header
        .getByRole("link", { name: "Back to the Inbox entries" })
        .click();
      await expect(page).toHaveURL(`${dashboard.baseURL}/inbox`);
    });
  });

  test("counts every open code change past the listed ones", async ({
    page,
    dashboard,
  }) => {
    // The reports list at most 100 changes. The counts cover every change.
    await page.route(/\/api\/people\/[^/]+\/code$/, async (route) => {
      const report = await mockPeopleCode(route);
      await route.fulfill({
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
      const report = await mockCodeRepository(route);
      const state = new URL(route.request().url()).searchParams.get("state");
      const changes = (count: number, changeState: string, title: string) =>
        Array.from({ length: count }, (_, index) => ({
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

    await page.goto(`${dashboard.baseURL}/code?scope=all`);
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
      const report = await mockCodeRepository(route);
      const idleChange = {
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
      });
    });
    await page.goto(`${dashboard.baseURL}/code?scope=all`);
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

  test("the repository Conversations tab keeps a pin in place, and Pinned lists only the pins", async ({
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

    // Pinned is a tab of the state filters, which start on All.
    const rows = list.getByRole("navigation", {
      name: "Conversations to show",
    });
    const all = rows.getByRole("link", { exact: true, name: "All" });
    const pinnedTab = rows.getByRole("link", { exact: true, name: "Pinned" });
    await expect(all).toHaveAttribute("aria-current", "page");
    await pinnedTab.click();
    await expect(page).toHaveURL(/\/conversations\?pinned=1$/);
    await expect(pinned).toBeVisible();
    await expect(unpinned).toHaveCount(0);
    await page.reload();
    await expect(pinnedTab).toHaveAttribute("aria-current", "page");
    await expect(pinned).toBeVisible();
    await expect(unpinned).toHaveCount(0);

    await all.click();
    await expect(page).not.toHaveURL(/[?&]pinned=1/);
    await expect(unpinned).toBeVisible();
  });

  test("the repository Conversations tab says how to pin when Pinned finds no pin", async ({
    page,
    dashboard,
  }) => {
    const list = await openRepositoryConversations(page, dashboard.baseURL);
    await expect(
      list.getByRole("link", { name: /^Open / }).first(),
    ).toBeVisible();
    await list
      .getByRole("navigation", { name: "Conversations to show" })
      .getByRole("link", { exact: true, name: "Pinned" })
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
        const feed = await mockFeedPage(route);
        const first = feed.conversations[0]!;
        const listed = (name: string, treeState: string) => ({
          ...first,
          conversationId: `${first.conversationId}-${treeState}`,
          displayTitle: name,
          pinnedAt: null,
          treeState,
        });
        return route.fulfill({
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
    // All, the default, is at the right edge, after Pinned.
    await expect(filters.getByRole("link")).toHaveText([
      /^Done$/,
      /^Watching$/,
      /^Working$/,
      /^Needs you$/,
      /^Pinned$/,
      /^All$/,
    ]);
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

  test.describe("the repository Conversations tab holds its order", () => {
    /**
     * List "Older conversation" below "Newer conversation". The returned
     * function moves new activity to the older one, or takes it back, and
     * moves the token that the versions poll reads.
     */
    async function mockMovingConversations(page: Page) {
      let moved = false;
      const versions = {
        conversationDetails: {},
        conversations: "feed-1",
        inboxItems: "items-1",
        spend: "spend-1",
      };
      await page.route("**/api/versions*", (route) =>
        route.fulfill({ json: versions }),
      );
      await page.route(
        /\/api\/conversations\?.*codeRepositoryId=/,
        async (route) => {
          const feed = await mockFeedPage(route);
          const first = feed.conversations[0]!;
          const row = (name: string, ageMs: number) => ({
            ...first,
            conversationId: `${first.conversationId}-${name}`,
            displayTitle: `${name} conversation`,
            lastSeenAt: new Date(NOW_MS - ageMs).toISOString(),
            pinnedAt: null,
          });
          return route.fulfill({
            json: {
              ...feed,
              conversations: [
                row("Older", moved ? 60_000 : 180_000),
                row("Newer", 120_000),
              ],
            },
          });
        },
      );
      let version = 1;
      return (next: boolean) => {
        moved = next;
        version += 1;
        versions.conversations = `feed-${version}`;
      };
    }

    test("holds the order under the pointer and offers the new one", async ({
      page,
      dashboard,
    }) => {
      // A fixed time keeps the row times in the screenshot the same.
      await page.clock.install({ time: NOW_MS });
      await page.setViewportSize(desktop);
      const setMoved = await mockMovingConversations(page);
      const list = await openRepositoryConversations(page, dashboard.baseURL);
      const rows = list.getByRole("link", { name: /^Open \w+ conversation$/ });
      const older = list.getByRole("link", {
        name: "Open Older conversation",
      });
      const pill = page.getByRole("button", { name: "1 updated" });
      await expect(rows.first()).toHaveAccessibleName(
        "Open Newer conversation",
      );

      // While the pointer is on the list, the rows keep their place, and the
      // pill offers the new order.
      await older.hover();
      setMoved(true);
      // The next versions poll reads the new feed token.
      await page.clock.fastForward(5_000);
      await expect(pill).toBeVisible();
      await expect(rows.first()).toHaveAccessibleName(
        "Open Newer conversation",
      );
      await screenshot(page, "repository-conversations-held", {
        lightTheme: true,
        view: "desktop",
      });

      // The pill applies the new order.
      await pill.click();
      await expect(rows.first()).toHaveAccessibleName(
        "Open Older conversation",
      );
      await expect(pill).toHaveCount(0);

      // Leaving the list, pointer and focus both, applies the next order.
      await older.hover();
      setMoved(false);
      // The next versions poll reads the new feed token.
      await page.clock.fastForward(5_000);
      await expect(pill).toBeVisible();
      await page.mouse.move(5, 890);
      await expect(rows.first()).toHaveAccessibleName(
        "Open Newer conversation",
      );
      await expect(pill).toHaveCount(0);
    });
  });
});
