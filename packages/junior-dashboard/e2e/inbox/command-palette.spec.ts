import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import type { Page } from "@playwright/test";

import { mockLandingAutomationApis } from "../automation-landing-fixture";
import { expandRow, mockInboxItems, rollout, rowHead } from "./inbox-fixture";
import { expect, test } from "../test";
import { waitForSettingsReads } from "../harness";
import { desktop, mobile, screenshot } from "../screenshot";
import { pickOption } from "../pick-option";
import { expectRequestBudget } from "../request-budget";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const CHECKOUT_TRIAGE_ID = "slack:CQA123:1770000000.000100";
  const CLOSED_ISSUE_ID = "agent-dispatch:event-1";

  const question = {
    owner: { id: CLOSED_ISSUE_ID, kind: "conversation" },
    rootConversationId: CLOSED_ISSUE_ID,
    assignedToEveryone: false,
    assignees: [
      {
        displayName: "Dashboard User",
        email: "dev@example.com",
        userId: "u-dev",
      },
    ],
    body: "The rollback is ready.",
    canAct: true,
    canTake: false,
    conversationIds: [CLOSED_ISSUE_ID],
    createdAt: "2026-08-07T08:00:00.000Z",
    id: "item-rollback",
    subject: { id: "item-rollback", kind: "question" },
    kind: "action" as const,
    request: {
      question: "Roll back payments-v42?",
      fields: [
        {
          id: "go",
          kind: "choice",
          label: "Rollback",
          options: [{ label: "Roll back" }, { label: "Hold" }],
        },
      ],
    },
    status: "open" as const,
    title: "Approve the payments-v42 rollback",
    updatedAt: "2026-08-07T08:30:00.000Z",
    visibility: "public" as const,
  };

  /**
   * Make the viewer a participant, so the Conversation has a reply box. With
   * `inboxItemId`, Junior added that Inbox item last.
   */
  async function routeAsParticipant(
    page: Page,
    conversationId: string,
    inboxItemId?: string,
  ) {
    await page.route(
      `**/api/conversations/${encodeURIComponent(conversationId)}*`,
      async (route) => {
        const response = await route.fetch({
          headers: {
            ...route.request().headers(),
            [CONVERSATION_DETAIL_VERSION_HEADER]: "",
          },
        });
        const detail = await response.json();
        const last = detail.events.at(-1);
        const events = inboxItemId
          ? [
              ...detail.events,
              {
                createdAt: last.createdAt,
                data: {
                  calls: [
                    {
                      name: "addInboxItem",
                      output: { item: { id: inboxItemId } },
                      status: "completed",
                      toolCallId: "add-inbox-item",
                    },
                  ],
                  type: "tool_calls",
                },
                seq: last.seq + 1,
              },
            ]
          : detail.events;
        await route.fulfill({
          response,
          json: { ...detail, events, isParticipant: true },
        });
      },
    );
  }

  test("switches conversations from the command palette without a server search", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    // Rows must not wait on the server search.
    await page.route(/\/api\/conversations\?q=/, (route) => route.abort());
    await routeAsParticipant(page, CHECKOUT_TRIAGE_ID);
    await page.goto(`${dashboard.baseURL}/inbox`);

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    const input = palette.getByRole("combobox");
    await expect(input).toBeFocused();
    // The Conversations tab shows, so its recent rows lead under its name.
    await expect(palette.getByRole("group").first()).toHaveAccessibleName(
      "Conversations",
    );

    // Scattered letters match.
    await input.fill("chk tri");
    const results = palette.getByRole("group", { name: "Conversations" });
    await expect(results.getByRole("option")).toHaveCount(1);
    await expect(
      results.getByRole("option", { name: /Checkout latency triage/ }),
    ).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");

    await expect(palette).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Checkout latency triage" }),
    ).toBeVisible();
    // The reader switched to talk there, so the reply box takes focus.
    await expect(
      page.getByRole("textbox", { name: "Continue this conversation" }),
    ).toBeFocused();

    // The open conversation is not a row, so Enter switches away from it.
    await page.getByRole("button", { name: "Search" }).click();
    await expect(input).toBeFocused();
    await expect(
      palette.getByRole("option", { name: /Checkout latency triage/ }),
    ).toHaveCount(0);
    // A typo still matches.
    await input.fill("chekcout");
    await expect(
      palette.getByRole("option", { name: /Investigate checkout latency/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  });

  test("a palette switch focuses the message box, and a question that loads later leaves it there", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await routeAsParticipant(page, CLOSED_ISSUE_ID, question.id);
    // The question sits on a second page that loads after the reply box
    // shows, and a third page loads after the reader starts to type.
    let releaseQuestion = () => {};
    const questionHeld = new Promise<void>((resolve) => {
      releaseQuestion = resolve;
    });
    let lastPageSent = false;
    let releaseLastPage = () => {};
    const lastPageHeld = new Promise<void>((resolve) => {
      releaseLastPage = resolve;
    });
    await page.route(`**/api/inbox-items?*`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("conversationId") !== CLOSED_ISSUE_ID) {
        return route.fallback();
      }
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        return route.fulfill({ json: { items: [], nextCursor: "page-2" } });
      }
      if (cursor === "page-2") {
        await questionHeld;
        return route.fulfill({
          json: { items: [question], nextCursor: "page-3" },
        });
      }
      await lastPageHeld;
      await route.fulfill({ json: { items: [] } });
      lastPageSent = true;
    });
    await page.goto(`${dashboard.baseURL}/inbox`);

    await page.keyboard.press("ControlOrMeta+k");
    const input = page
      .getByRole("dialog", { name: "Go to conversation" })
      .getByRole("combobox");
    await input.fill("closed issue");
    await input.press("Enter");
    const composer = page.getByLabel("Continue this conversation");
    await expect(composer).toBeVisible();

    // The message box takes the focus at once. The question shows in the
    // transcript when its page loads, and does not take the focus.
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Hold on");
    releaseQuestion();
    releaseLastPage();
    await expect.poll(() => lastPageSent).toBe(true);
    // Let the app render the last page before the next keys.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await composer.pressSequentially(" 1");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText("Hold on 1", { useInnerText: true });
  });

  test("jumps to a page from the command palette", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    // A page outside the tabs, so no tab's rows lead.
    await page.goto(`${dashboard.baseURL}/settings`);

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    const input = palette.getByRole("combobox");
    await expect(palette.getByRole("group", { name: "Recent" })).toBeVisible();
    // The highlighted recent conversation still matches "co" loosely, but the
    // page whose name starts with it ranks first and takes Enter.
    await input.fill("co");
    await input.press("Enter");

    await expect(page).toHaveURL(/\/code$/);
    await expect(palette).toHaveCount(0);
  });

  test("finds the pages of every menu by name", async ({ page, dashboard }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.goto(`${dashboard.baseURL}/inbox`);

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    const input = palette.getByRole("combobox");
    const pages = palette.getByRole("group", { name: "Go to" });
    // One page from each menu: the pane, the profile menu, and the pages
    // that the Automations, System, Memories, and Settings areas list.
    for (const name of [
      "Snoozed",
      "Code",
      "Settings",
      "My profile",
      "Automation runs",
      "Workspaces",
      "Memory library",
      "API Tokens",
    ]) {
      await input.fill(name);
      await expect(
        pages.getByRole("option", { name: new RegExp(`^${name}`) }),
      ).toBeVisible();
    }
    await screenshot(page, "inbox-palette-pages", { lightTheme: true });

    await input.fill("API Tokens");
    const settingsRead = waitForSettingsReads(page);
    await input.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings#api-tokens$/);
    await expect(
      page.getByRole("heading", { name: "API Tokens" }),
    ).toBeVisible();
    await settingsRead;
  });

  test("sends feedback from the command palette", async ({
    page,
    dashboard,
  }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        __JUNIOR_DASHBOARD_SENTRY__: {
          dsn: "https://public@sentry.example/1",
          tracesSampleRate: 0,
        },
      });
    });
    await page.route("https://sentry.example/**", (route) =>
      route.fulfill({ json: {} }),
    );
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.goto(`${dashboard.baseURL}/inbox`);

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    await palette.getByRole("combobox").fill("feedback");
    const entry = palette
      .getByRole("group", { name: "Actions" })
      .getByRole("option", { name: "Send feedback" });
    await expect(entry).toHaveAttribute("aria-selected", "true");
    await screenshot(page, "inbox-palette-feedback", { lightTheme: true });
    await page.keyboard.press("Enter");

    await expect(palette).toHaveCount(0);
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    // On a phone the palette offers it too.
    await page.setViewportSize(mobile);
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("combobox").fill("feedback");
    await pickOption(palette.getByRole("option", { name: "Send feedback" }));
    await expect(dialog).toBeVisible();
  });

  test("ranks the active tab's results first", async ({ page, dashboard }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await mockInboxItems(page);
    await mockLandingAutomationApis(page);
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    for (const [path, group] of [
      ["/automations", "Automations"],
      // The Inbox tab ranks its Conversations first.
      ["/", "Conversations"],
    ] as const) {
      await page.goto(`${dashboard.baseURL}${path}`);
      await page.keyboard.press("ControlOrMeta+k");
      await expect(palette.getByRole("group").first()).toHaveAccessibleName(
        group,
      );
      await page.keyboard.press("Escape");
    }

    // A match in an Automation's instruction comes from the server.
    await page.goto(`${dashboard.baseURL}/automations`);
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("combobox").fill("announcement post");
    const automations = palette.getByRole("group").first();
    await expect(automations).toHaveAccessibleName("Automations");
    await expect(automations.getByRole("option").first()).toHaveAccessibleName(
      /Fair Source PR review/,
    );
    await page.keyboard.press("Escape");
    await page.goto(`${dashboard.baseURL}/inbox`);

    // On the Inbox, a match in an item's body text shows, and picking it
    // opens the list with that item's row expanded.
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("combobox").fill("canary error");
    const inbox = palette.getByRole("group", { exact: true, name: "Inbox" });
    const match = inbox.getByRole("option").first();
    await expect(match).toHaveAccessibleName(new RegExp(rollout.title));
    await pickOption(match);
    await expect(page).toHaveURL(/\/inbox\?view=inbox$/);
    await expect(
      // In its stack, the item's own row opens, under its question.
      page.getByRole("region", { name: /: asks$/ }).filter({
        hasText: rollout.request.question,
      }),
    ).toBeVisible();
  });

  test("a snoozed match opens Snoozed with its row expanded", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await mockInboxItems(page, { open: [rollout] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(rowHead(page, "Investigate checkout latency"));
    await page.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Tomorrow" }).click();
    await expect(
      page
        .getByRole("region", { name: "To do" })
        .getByRole("link", { name: /Investigate checkout latency/ }),
    ).toHaveCount(0);

    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("combobox").fill("canary error");
    await pickOption(
      palette
        .getByRole("group", { exact: true, name: "Inbox" })
        .getByRole("option", { name: new RegExp(rollout.title) }),
    );
    await expect(page).toHaveURL(/\/inbox\?view=snoozed$/);
    const asks = page.getByRole("region", { name: /: asks$/ });
    await expect(
      page.locator(`li[data-inbox-row="${rollout.id}"]`),
    ).toHaveAttribute("data-expanded", "true");
    // It wakes from the open row.
    await asks.getByRole("button", { name: "Wake" }).click();
    await expect(page.getByText("Nothing snoozed")).toBeVisible();
  });

  test("searches the directory pages, with the page's group first", async ({
    context,
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    const firstMatch = async (
      path: string,
      query: string,
      group: string,
      name: RegExp,
    ) => {
      await page.goto(`${dashboard.baseURL}${path}`);
      await page.keyboard.press("ControlOrMeta+k");
      await palette.getByRole("combobox").fill(query);
      const first = palette.getByRole("group").first();
      await expect(first).toHaveAccessibleName(group);
      const match = first.getByRole("option").first();
      await expect(match).toHaveAccessibleName(name);
      return match;
    };

    await (
      await firstMatch("/system/people", "avery", "People", /Avery Example/)
    ).click();
    await expect(page).toHaveURL(/\/people\/avery%40example\.com$/);

    await (
      await firstMatch(
        "/system/locations",
        "checkout",
        "Locations",
        /#proj-checkout/,
      )
    ).click();
    await expect(page).toHaveURL(/\/system\/locations\/mock%3ACQA123$/);

    await (
      await firstMatch("/code", "junior", "Repositories", /getsentry\/junior/)
    ).click();
    await expect(
      page.getByRole("heading", { name: "getsentry/junior", exact: true }),
    ).toBeVisible();

    // On a repository, its changes lead, and one opens on its provider.
    await context.route("https://github.com/**", (route) =>
      route.fulfill({ body: "" }),
    );
    const change = await firstMatch(
      new URL(page.url()).pathname,
      "repository context",
      "Changes",
      /Keep repository context across turns/,
    );
    const opened = context.waitForEvent("page");
    await change.click();
    await expect(await opened).toHaveURL(
      "https://github.com/getsentry/junior/pull/781",
    );

    await (
      await firstMatch("/automations/runs", "weekly", "Runs", /Weekly project/)
    ).click();
    await expect(page).toHaveURL(/\/automations\/runs\?run=/);
    // The run opens in the conversation drawer, named by its Automation.
    await expect(
      page.getByRole("dialog", { name: "Weekly project summary" }),
    ).toBeVisible();
  });

  test("closed Inbox matches show under Done, after the open ones", async ({
    page,
    dashboard,
  }) => {
    await mockInboxItems(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    await palette.getByRole("combobox").fill("license entry");
    const groups = palette.getByRole("group");
    await expect(groups.nth(0)).toHaveAccessibleName("Inbox");
    await expect(groups.nth(1)).toHaveAccessibleName("Done");
    const closed = groups.nth(1).getByRole("option").first();
    await expect(closed).toHaveAccessibleName(/initech license entry/);
    await pickOption(closed);
    // Done opens with the item's row expanded.
    await expect(page).toHaveURL(/\/inbox\?view=done$/);
    await expect(
      page.getByRole("region", {
        name: "Review the initech license entry: how it closed",
      }),
    ).toBeVisible();
  });

  test("finds To-dos, with closed ones under Done, and opens their Conversation", async ({
    page,
    dashboard,
  }) => {
    await page.goto(dashboard.baseURL);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    await palette.getByRole("combobox").fill("dashboard");
    const group = (name: string) =>
      palette.getByRole("group", { exact: true, name }).getByRole("option");
    await expect(group("To-dos")).toHaveText([
      /Fix the failing dashboard checks/,
      /Review the dashboard plan before editing/,
    ]);
    await expect(group("Done")).toHaveText([/Port the old dashboard theme/]);
    await expect(group("Done")).toContainText("To-do");
    for (const view of [desktop, mobile]) {
      await page.setViewportSize({ height: view.height, width: view.width });
      await group("To-dos").first().hover();
      await expect(group("To-dos").first()).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await screenshot(page, "inbox-palette-todos", {
        lightTheme: true,
        view: view.name,
      });
    }

    await pickOption(group("To-dos").first());
    await expect(page).toHaveURL(/\/conversations\/internal%3Adashboard-qa$/);
    await expect(
      page.getByRole("heading", { name: "Dashboard QA edge cases" }),
    ).toBeVisible();
  });

  test("finds Inbox items, Automations, and Memories with one search for each typed query", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await mockInboxItems(page);
    await mockLandingAutomationApis(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    await expect(palette.getByRole("group").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const group = (name: string) =>
      palette.getByRole("group", { exact: true, name }).getByRole("option");
    const listSearches: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.searchParams.has("q") &&
        [
          "/api/automations",
          "/api/inbox-items",
          "/api/user-pages/memory/memories",
        ].includes(url.pathname)
      )
        listSearches.push(url.pathname);
    });

    await expectRequestBudget(
      page,
      async () => {
        // A half-typed word finds the text with a word that it starts: a
        // title match first, then a match in an instruction.
        await palette.getByRole("combobox").fill("revie");
        await expect(group("Automations")).toHaveText([
          /Fair Source PR review/,
          /Post-merge cleanup/,
        ]);
      },
      { requests: 6, serialRounds: 2 },
    );

    expect(listSearches).toEqual([]);
    await expect(group("Memories")).toHaveText([
      /Start incident reviews with the customer impact/,
    ]);
    await expect(group("Inbox")).toHaveCount(3);
    await expect(group("To-dos")).toHaveText([
      /Review the dashboard plan before editing/,
    ]);
    await expect(group("Done")).toHaveText([
      /Review the initech license entry/,
      /Read the review feedback/,
    ]);
    // Conversations lead the list, so show the server-matched groups.
    // A resize resets the scroll, so each size gets its own shot.
    const shot = async (view: typeof desktop | typeof mobile) => {
      await page.setViewportSize({ height: view.height, width: view.width });
      // Highlight the row, since the palette keeps the highlight in view.
      await group("Memories").first().hover();
      await expect(group("Memories").first()).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await screenshot(page, "inbox-palette-search", {
        lightTheme: true,
        view: view.name,
      });
    };
    await shot(desktop);
    await shot(mobile);
  });

  test("waits for every server search before it says nothing matches", async ({
    page,
    dashboard,
  }) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/search\?/, async (route) => {
      await released;
      await route.fallback();
    });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    const conversationsSearched = page.waitForResponse((response) =>
      response.url().includes("/api/conversations?q="),
    );
    await palette.getByRole("combobox").fill("zzqx nothing");
    // The conversation search has answered; `/api/search` still reads.
    await conversationsSearched;
    await expect(palette.getByText("Searching…")).toBeVisible();
    await expect(palette.getByText("No matches.")).toHaveCount(0);
    release();
    await expect(palette.getByText("No matches.")).toBeVisible();
    await expect(palette.getByText("Searching…")).toHaveCount(0);
  });

  test("lists the open repository's matching conversations first", async ({
    page,
    dashboard,
  }) => {
    await page.goto(
      `${dashboard.baseURL}/code/00000000-0000-4000-8000-000000000003`,
    );
    await expect(
      page.getByRole("heading", { name: "getsentry/junior", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    // "Investigate checkout latency" matches the title better, but it has no
    // change in this repository.
    await palette.getByRole("combobox").fill("ate");
    const conversations = palette.getByRole("group", { name: "Conversations" });
    await expect(
      conversations.getByRole("option").first(),
    ).toHaveAccessibleName(/Package release and self-update/);
    await expect(
      conversations.getByRole("option", {
        name: /Investigate checkout latency/,
      }),
    ).toBeVisible();
  });

  test("searches a plugin page from the palette, with its group first", async ({
    page,
    dashboard,
  }) => {
    await page.route("**/api/user-pages", (route) =>
      route.fulfill({
        json: [
          {
            description: "Deploy checklists that a fixture plugin owns.",
            id: "checklists",
            label: "Checklists",
            navigation: "profile",
            pluginDisplayName: "Fixture",
            pluginName: "fixture",
          },
        ],
      }),
    );
    const checklists = Array.from({ length: 24 }, (_, index) => ({
      id: `checklist-${index + 1}`,
      title:
        index === 20
          ? "Deploy the payments service"
          : `Routine checklist ${index + 1}`,
    }));
    const queries: string[] = [];
    await page.route("**/api/user-pages/fixture/checklists*", (route) => {
      const query = new URL(route.request().url()).searchParams.get("q") ?? "";
      queries.push(query);
      return route.fulfill({
        json: {
          records: checklists.filter((record) =>
            record.title.toLowerCase().includes(query.toLowerCase()),
          ),
          searchPlaceholder: "Search checklists",
          type: "list",
        },
      });
    });

    await page.setViewportSize({ height: 700, width: 1280 });
    await page.goto(`${dashboard.baseURL}/plugins/fixture/checklists`);
    await expect(
      page.getByRole("heading", { name: "Routine checklist 1", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    // "Deployment investigation failed" is a Conversation match too.
    await palette.getByRole("combobox").fill("deploy");
    const first = palette.getByRole("group").first();
    await expect(first).toHaveAccessibleName("Checklists");
    await expect(
      palette.getByRole("group", { name: "Conversations" }),
    ).toBeVisible();
    const match = first.getByRole("option").first();
    await expect(match).toHaveAccessibleName(/Deploy the payments service/);
    expect(queries).toContain("deploy");

    await pickOption(match);
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/plugins/fixture/checklists#record-checklist-21`,
    );
    const record = page.locator("#record-checklist-21");
    await expect(record).toHaveAttribute("aria-current", "true");
    await expect(record).toBeInViewport();
  });
});
