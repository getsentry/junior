import { mockAutomationCollection } from "../../src/mock-reporting/automation-collection";
import { automationReport } from "./automation-fixture";
import { startDashboardE2eServer } from "../harness";
import {
  automationAlert,
  license,
  mockInboxItems,
  openRow,
} from "./inbox-fixture";
import { expect, test } from "../test";
import { mobile, screenshot } from "../screenshot";

test.describe("new UI", () => {
  const SPEND_LABEL = "Personal model spend: 7 days $0.46, 30 days $0.46";

  test("shows the primary destinations at the top of every desktop pane", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/inbox`);

    const primary = page.getByRole("navigation", { name: "Primary" });
    // One list of labelled rows: the Lead, the Inbox views, Conversations,
    // Code, and Automations. The Inbox filters its asks by type, so the pane
    // has no rows for them. No tab bar sits above them.
    await expect(page.getByRole("tablist")).toHaveCount(0);
    const rows = primary.getByRole("link");
    const names = [
      "Lead",
      /^Inbox, \d+ waiting$/,
      "Snoozed",
      "Done",
      "Conversations",
      "Code",
      /^Automations/,
    ];
    for (const [index, name] of names.entries())
      await expect(rows.nth(index)).toHaveAccessibleName(name);
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "page");
    await expect(
      primary.getByRole("heading", { name: "Asks by type" }),
    ).toHaveCount(0);
    await expect(
      primary.getByRole("link", { name: /^(Pull requests|Decisions)/ }),
    ).toHaveCount(0);

    // Automations keeps the same pane, with its row marked.
    await primary.getByRole("link", { name: /^Automations/ }).click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
    await expect(
      primary.getByRole("link", { name: /^Automations/ }),
    ).toHaveAttribute("aria-current", "page");
    await expect(rows.nth(1)).toHaveAccessibleName(/^Inbox, \d+ waiting$/);
    // The profile row keeps the running spend totals in view.
    const profile = page.getByRole("button", {
      name: /^Open profile menu for Dashboard User\./,
    });
    await expect(profile).toHaveAccessibleName(
      `Open profile menu for Dashboard User. ${SPEND_LABEL}.`,
    );
    await expect(profile).toContainText("7d$0.46");
    await expect(profile).toContainText("30d$0.46");
    await screenshot(page, "navigation-pane-automations", { view: "desktop" });

    // The pane is part of the layout: a width set on one page holds on all.
    const resize = page.getByRole("separator", { name: "Resize sidebar" });
    const paneWidth = async () =>
      Number(await resize.getAttribute("aria-valuenow"));
    const startWidth = await paneWidth();
    // The pane starts slim, so the list beside it has the room.
    expect(startWidth).toBe(288);
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(paneWidth).toBe(startWidth + 32);
    await primary.getByRole("link", { name: /^Inbox/ }).click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/inbox`);
    await expect.poll(paneWidth).toBe(startWidth + 32);
    await page.reload();
    await expect.poll(paneWidth).toBe(startWidth + 32);
  });

  test("the pane's search bar fits its label, and drops the shortcut chip when narrow", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const search = page.getByRole("button", { name: /^Search/ });
    const label = search.getByText("Search", { exact: true });
    const chip = search.locator("kbd");
    const shortcut = /^Search \((Ctrl K|⌘K)\)$/;
    // The default width fits "Search" and the chip, untruncated.
    await expect(chip).toBeVisible();
    await expect
      .poll(() => label.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    await expect(search).toHaveAttribute("title", shortcut);
    await expect(search).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+K Control+K",
    );

    // A saved width wins over the default. At the pane's minimum width the
    // chip goes; the tooltip keeps the shortcut.
    await page.evaluate(() =>
      localStorage.setItem("junior:pane-width-rem", "13"),
    );
    await page.reload();
    const resize = page.getByRole("separator", { name: "Resize sidebar" });
    await expect(resize).toHaveAttribute("aria-valuenow", "208");
    await expect(search).toBeVisible();
    await expect(chip).toBeHidden();
    await expect(search).toHaveAttribute("title", shortcut);
    await expect(search).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+K Control+K",
    );
  });

  test("the pane's spend meter takes 2 rows when tall and one compact row when short", async ({
    page,
    dashboard,
  }) => {
    const EXACT = "Personal model spend: 7 days $2,092.01, 30 days $7,019.00";
    await page.route("**/api/people/me/spend", (route) =>
      route.fulfill({
        json: {
          generatedAt: "2026-11-16T00:00:00.000Z",
          sevenDaysUsd: 2092.01,
          source: "conversation_index",
          thirtyDaysUsd: 7019,
          windowEnd: "2026-11-16T00:00:00.000Z",
          windowStart: "2026-10-17T00:00:00.000Z",
        },
      }),
    );
    const profile = page.getByRole("button", {
      name: /^Open profile menu for Dashboard User\./,
    });
    const meter = profile.locator("[data-spend-meter]");
    const rows = meter.locator('[data-spend-meter-mode="rows"]');
    const compact = meter.locator('[data-spend-meter-mode="compact"]');

    // 720px and up: 7d over 30d, with the full amounts.
    await page.setViewportSize({ width: 1440, height: 720 });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expect(profile).toHaveAccessibleName(
      `Open profile menu for Dashboard User. ${EXACT}.`,
    );
    await expect(rows).toBeVisible();
    await expect(rows).toHaveText("7d$2,092.0130d$7,019.00");
    await expect(compact).toBeHidden();
    await expect(meter).toHaveAttribute("title", EXACT);

    // Shorter: one compact row, with the exact amounts in its tooltip.
    await page.setViewportSize({ width: 1440, height: 719 });
    await expect(compact).toBeVisible();
    await expect(compact).toHaveText("7d$2.1K·30d$7K");
    await expect(rows).toBeHidden();
    await expect(meter).toHaveAttribute("title", EXACT);
    await expect(profile).toHaveAccessibleName(
      `Open profile menu for Dashboard User. ${EXACT}.`,
    );

    // Amounts under $1,000 stay exact in the compact row.
    await page.unroute("**/api/people/me/spend");
    await page.reload();
    await expect(compact).toHaveText("7d$0.46·30d$0.46");
  });

  test("Automations is a row that counts your Automations to do", async ({
    page,
    dashboard,
  }) => {
    // One of the viewer's Automations is blocked, so it waits on them.
    const report = structuredClone(automationReport);
    Object.assign(
      report.automations.find((automation) => automation.id === "scheduled-1")!,
      { status: "blocked", statusReason: "GitHub access expired." },
    );
    await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: mockAutomationCollection(
          report,
          new URL(route.request().url()).searchParams,
        ),
      }),
    );
    await mockInboxItems(page, {
      open: [automationAlert("scheduled-1", "Weekly project summary")],
      automations: () =>
        mockAutomationCollection(
          report,
          new URLSearchParams({ owner: "me", scope: "attention" }),
        ).total,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const primary = page.getByRole("navigation", { name: "Primary" });
    const automations = primary.getByRole("link", { name: /^Automations/ });
    // The row sits with Conversations, and its count is the Inbox's To do
    // Automations, which its page lists first.
    await expect(automations).toHaveAccessibleName("Automations, 1 waiting");
    await automations.click();
    const todo = page.getByRole("region", { exact: true, name: "To do" });
    await expect(todo.getByRole("listitem")).toHaveText([
      /Weekly project summary/,
    ]);
    // The old Automations bundle opens the page instead.
    await page.goto(`${dashboard.baseURL}/?view=automations`);
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
    await page.goto(`${dashboard.baseURL}/review?bundle=automations`);
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
    // The pane stays on the Automation pages too.
    const runsRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/automations/runs",
    );
    await page.goto(`${dashboard.baseURL}/automations/runs`);
    await expect(automations).toHaveAttribute("aria-current", "page");
    await expect(primary.getByRole("link", { name: /^Inbox/ })).toBeVisible();
    await runsRead;
  });

  test("an old Automations link does not become the Inbox's place", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/?view=automations`);
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
    const inbox = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ });
    await expect(inbox).toHaveAttribute("href", "/inbox");
    // The old link would bounce the reader back to Automations.
    await inbox.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/inbox`);
    await expect(inbox).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { exact: true, name: "Automations" }),
    ).toHaveCount(0);
  });

  test("the phone menu lists the same destinations, without tabs", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${dashboard.baseURL}/automations`);
    await page.getByRole("button", { name: "Open navigation" }).click();
    const sheet = page.getByRole("dialog", { name: "Navigation" });
    const primary = sheet.getByRole("navigation", { name: "Primary" });
    await expect(sheet.getByRole("tablist")).toHaveCount(0);
    await expect(
      primary.getByRole("link", { name: /^Automations/ }),
    ).toHaveAttribute("aria-current", "page");
    await primary
      .getByRole("link", { name: "Conversations", exact: true })
      .click();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/inbox?view=conversations`,
    );
  });

  test("names New after the page that shows", async ({ page, dashboard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [path, name] of [
      ["/", "New conversation"],
      ["/inbox", "New conversation"],
      ["/automations", "New automation"],
    ] as const) {
      await page.goto(`${dashboard.baseURL}${path}`);
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    // New on Automations starts the ask in a new conversation.
    await page.getByRole("button", { name: "New automation" }).click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/conversations/new`);
    await expect(page.getByLabel("Start a conversation")).toHaveText(
      /^Set up an automation that /,
      { useInnerText: true },
    );
  });

  test("hides the pane and keeps the choice", async ({ page, dashboard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/automations`);

    const primary = page.getByRole("navigation", { name: "Primary" });
    await expect(primary).toBeVisible();
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(primary).toBeHidden();
    // Only the toggle and the command palette stay.
    const show = page.getByRole("button", { name: "Show sidebar" });
    await expect(show).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Go to conversation" }),
    ).toBeVisible();
    // The header keeps the spend totals where it has room for them.
    const spend = page.getByRole("group", { name: SPEND_LABEL, exact: true });
    await expect(spend).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(spend).toBeHidden();
    await expect(show).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(spend).toBeVisible();

    // The choice survives a reload and a move to another page.
    await page.reload();
    await expect(primary).toBeHidden();
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expect(primary).toBeHidden();
    const entries = page.getByRole("navigation", { name: "Primary" });
    await expect(entries).toBeHidden();

    // Cmd/Ctrl+B shows it again.
    await page.keyboard.press("ControlOrMeta+b");
    await expect(primary).toBeVisible();
    await expect(entries).toBeVisible();
  });

  test("reopens each row where the reader left it", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/automations/runs`);
    const primary = page.getByRole("navigation", { name: "Primary" });
    const automations = primary.getByRole("link", { name: /^Automations/ });

    const inbox = primary.getByRole("link", { name: /^Inbox/ });
    await inbox.click();
    await expect(inbox).toHaveAttribute("aria-current", "page");
    await automations.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations/runs`);
    // A press on the row that shows goes back to its top level.
    const listRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/automations" &&
        new URL(response.url()).searchParams.get("pageSize") === "100",
    );
    await automations.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
    await listRead;

    // The pane's search bar opens the command palette, which reads the
    // viewer's Automations when it opens.
    await page.getByRole("button", { name: /^Search/ }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Go to conversation" })
        .getByRole("group", { name: "Automations" })
        .getByRole("option")
        .first(),
    ).toBeVisible();
  });

  test("marks the view that opened a Conversation, and Back returns there, across reload", async ({
    page,
    dashboard,
  }) => {
    await mockInboxItems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const conversationUrl = `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`;
    const primary = page.getByRole("navigation", { name: "Primary" });
    const inbox = primary.getByRole("link", { name: /^Inbox/ });
    const conversations = primary.getByRole("link", {
      exact: true,
      name: "Conversations",
    });
    const title = page.getByRole("heading", {
      name: "Checkout latency triage",
    });
    const backToConversations = page.getByRole("link", {
      name: "Back to Conversations",
    });
    const backToInbox = page.getByRole("link", { name: "Back to Inbox" });

    // A direct link has no origin, so Conversations owns the page, and
    // Back goes there. The view is the list the page is in, not the page.
    await page.goto(conversationUrl);
    await expect(title).toBeVisible();
    await expect(conversations).toHaveAttribute("aria-current", "true");
    await expect(inbox).not.toHaveAttribute("aria-current");
    await expect(backToConversations).toHaveAttribute(
      "href",
      "/inbox?view=conversations",
    );
    await backToConversations.click();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/inbox?view=conversations`,
    );
    await expect(conversations).toHaveAttribute("aria-current", "page");

    // Opened from Conversations, it stays there after a reload, Back, and
    // Forward.
    await openRow(
      page
        .getByRole("region", { exact: true, name: "Conversations" })
        .getByRole("link", { name: /Checkout latency triage/ }),
    );
    await expect(page).toHaveURL(conversationUrl);
    await expect(conversations).toHaveAttribute("aria-current", "true");
    await page.reload();
    await expect(title).toBeVisible();
    await expect(conversations).toHaveAttribute("aria-current", "true");
    await expect(inbox).not.toHaveAttribute("aria-current");
    await expect(backToConversations).toHaveAttribute(
      "href",
      "/inbox?view=conversations",
    );
    await page.goBack();
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/inbox?view=conversations`,
    );
    await page.goForward();
    await expect(title).toBeVisible();
    await expect(conversations).toHaveAttribute("aria-current", "true");

    // Opened from the Inbox, it stays in the Inbox after a reload. Its
    // In flight row is the page, so only that row is fully marked.
    await page.goto(`${dashboard.baseURL}/inbox`);
    const inFlightRow = page
      .getByRole("list", { name: "In flight" })
      .getByRole("link", { name: /Investigate checkout latency/ });
    await inFlightRow.click();
    const running = page.getByRole("heading", {
      name: "Investigate checkout latency",
    });
    await expect(running).toBeVisible();
    await expect(inFlightRow).toHaveAttribute("aria-current", "page");
    await expect(inbox).toHaveAttribute("aria-current", "true");
    await page.reload();
    await expect(running).toBeVisible();
    await expect(inFlightRow).toHaveAttribute("aria-current", "page");
    await expect(inbox).toHaveAttribute("aria-current", "true");
    await expect(conversations).not.toHaveAttribute("aria-current");
    await expect(backToInbox).toHaveAttribute("href", "/inbox");
    await screenshot(page, "navigation-origin-in-flight", { lightTheme: true });

    // The Lead is a Conversation with its own row, so that row is the page.
    const lead = primary.getByRole("link", { exact: true, name: "Lead" });
    await lead.click();
    await expect(lead).toHaveAttribute("aria-current", "page");
    await expect(inbox).not.toHaveAttribute("aria-current");
  });

  test("marks the Inbox, but not as the page, for a Conversation it opened", async ({
    page,
    dashboard,
  }) => {
    // An ask from a Conversation that is not in flight.
    const triage = "slack:CQA123:1770000000.000100";
    await mockInboxItems(page, {
      open: [
        {
          ...license,
          conversationIds: [triage],
          owner: { id: triage, kind: "conversation" },
          rootConversationId: triage,
        },
      ],
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/inbox`);
    const primary = page.getByRole("navigation", { name: "Primary" });
    const inbox = primary.getByRole("link", { name: /^Inbox/ });
    await expect(inbox).toHaveAttribute("aria-current", "page");

    await openRow(
      page
        .getByRole("region", { name: "To do" })
        .getByRole("link", { name: /Review the acme license entry/ })
        .first(),
    );
    await expect(page).toHaveURL(
      /\/conversations\/slack%3ACQA123%3A1770000000/,
    );
    await expect(
      page.getByRole("heading", { name: "Checkout latency triage" }),
    ).toBeVisible();
    await expect(inbox).toHaveAttribute("aria-current", "true");
    await screenshot(page, "navigation-origin-inbox", { lightTheme: true });
  });

  test("keeps the density choice", async ({ page, dashboard }) => {
    const root = page.locator("html");
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    await expect(root).toHaveAttribute("data-density", "compact");
    // Comfortable gives a row's summary more lines.
    const row = page
      .getByRole("region", { exact: true, name: "Conversations" })
      .getByRole("listitem")
      .filter({
        has: page.getByRole("link", { name: /Checkout latency triage/ }),
      });
    // The clamp holds the summary's display text.
    const summary = row
      .getByText(/traced to payments-v42/)
      .locator("xpath=ancestor-or-self::*[contains(@class, 'line-clamp')][1]");
    await expect(summary).toHaveClass(/line-clamp-1/);

    await page.getByRole("button", { name: /Open profile menu/ }).click();
    await page
      .getByRole("menuitemradio", { name: "Comfortable density" })
      .click();
    await expect(root).toHaveAttribute("data-density", "comfortable");
    await expect(summary).toHaveClass(/line-clamp-2/);
    await page.reload({ waitUntil: "commit" });
    // The rows on screen read the cards of their links again after the
    // reload. Wait from the commit of the new document, so a read from the
    // page before the reload does not count.
    const cardsRead = ["pull/2201", "people/dev"].map((link) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/objects" &&
          url.searchParams.getAll("url").some((value) => value.includes(link))
        );
      }),
    );
    await expect(root).toHaveAttribute("data-density", "comfortable");
    await expect(summary).toHaveClass(/line-clamp-2/);
    await Promise.all(cardsRead);
  });

  test("hides and restores the panels with the shortcuts and Zen mode", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
    );
    const pane = page.getByRole("navigation", { name: "Primary" });
    const details = page.getByRole("complementary", {
      exact: true,
      name: "Conversation details",
    });
    const title = page.getByRole("heading", {
      name: "Checkout latency triage",
    });
    await expect(pane).toBeVisible();
    await expect(details).toBeVisible();

    await page.keyboard.press("ControlOrMeta+Alt+KeyB");
    await expect(details).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Alt+KeyB");
    await expect(details).toBeVisible();

    // Zen mode hides both and leaves the conversation.
    await page.keyboard.press("ControlOrMeta+Alt+KeyY");
    await expect(pane).toBeHidden();
    await expect(details).toBeHidden();
    await expect(title).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Alt+KeyY");
    await expect(pane).toBeVisible();
    await expect(details).toBeVisible();

    // Leaving it restores the panels as they were, here with details hidden.
    await page.keyboard.press("ControlOrMeta+Alt+KeyB");
    await expect(details).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Alt+KeyY");
    await expect(pane).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Alt+KeyY");
    await expect(pane).toBeVisible();
    await expect(details).toBeHidden();

    // Every page has Zen mode; without details, it hides the pane.
    for (const path of ["/settings", "/"]) {
      await page.goto(`${dashboard.baseURL}${path}`);
      await page.keyboard.press("ControlOrMeta+Alt+KeyY");
      await expect(pane).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Show sidebar" }),
      ).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Alt+KeyY");
      await expect(pane).toBeVisible();
    }
  });

  test("Zen mode hides the page links that the pane lists", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${dashboard.baseURL}/system`);
    const pane = page.getByRole("navigation", { name: "Primary" });
    const pageLinks = page.getByRole("navigation", {
      name: "System navigation",
    });
    await expect(pane).toBeVisible();
    await expect(pageLinks).toHaveCount(0);

    // Closing the pane shows them, because nothing else lists the pages.
    await page.keyboard.press("ControlOrMeta+KeyB");
    await expect(pane).toBeHidden();
    await expect(pageLinks).toBeVisible();

    // Zen mode hides the page chrome, and the page links with it.
    await page.keyboard.press("ControlOrMeta+Alt+KeyY");
    await expect(pageLinks).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Alt+KeyY");
    await expect(pageLinks).toBeVisible();
    await page.keyboard.press("ControlOrMeta+KeyB");
    await expect(pane).toBeVisible();
    await expect(pageLinks).toHaveCount(0);
  });

  test("mock data shows the local viewer's Inbox when auth is off", async ({
    page,
  }) => {
    const dashboard = await startDashboardE2eServer({ authRequired: false });
    try {
      await page.setViewportSize({ width: 1440, height: 1150 });
      await page.goto(`${dashboard.baseURL}/inbox`);
      const primary = page.getByRole("navigation", { name: "Primary" });
      await expect(primary.getByRole("link", { name: /^Inbox/ })).toHaveText(
        /^Inbox\s*\d+$/,
      );
      await expect(
        primary.getByRole("link", { name: "Automations" }),
      ).toBeVisible();
    } finally {
      await dashboard.close();
    }
  });

  test("sends feedback about the dashboard from the profile menu", async ({
    page,
    dashboard,
  }) => {
    const feedback: Record<string, unknown>[] = [];
    await page.addInitScript(() => {
      Object.assign(window, {
        __JUNIOR_DASHBOARD_SENTRY__: {
          dsn: "https://public@sentry.example/1",
          tracesSampleRate: 0,
        },
      });
    });
    await page.route("https://sentry.example/**", async (route) => {
      const item = route.request().postData()?.split("\n").at(-1) ?? "";
      if (item.includes('"type":"feedback"')) feedback.push(JSON.parse(item));
      await route.fulfill({ json: {} });
    });
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(`${dashboard.baseURL}/inbox`);

    await page.getByRole("button", { name: /^Open profile menu/ }).click();
    const entry = page.getByRole("menuitem", { name: "Send feedback" });
    await expect(entry).toBeVisible();
    await screenshot(page, "inbox-feedback-entry", {
      lightTheme: true,
      view: "desktop",
    });
    await entry.click();

    // Send waits for a topic and a comment.
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    const send = dialog.getByRole("button", { name: "Send" });
    await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(send).toBeDisabled();
    await screenshot(page, "inbox-feedback-dialog", {
      lightTheme: true,
      view: "desktop",
    });
    await dialog.getByRole("radio", { name: "The dashboard" }).click();
    await dialog
      .getByRole("textbox", { name: "Comment" })
      .fill("Snoozed rows are hard to find");
    await send.click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Feedback sent")).toBeVisible();
    await expect.poll(() => feedback.length).toBe(1);
    expect(feedback[0]).toMatchObject({
      contexts: {
        feedback: {
          contact_email: "dev@example.com",
          message: "Snoozed rows are hard to find",
          name: "Dashboard User",
          source: "dashboard_feedback",
        },
      },
      tags: { "app.feedback.topic": "new_ui" },
    });

    // On a phone the entry is in the navigation sheet, and the dialog opens
    // over it.
    await page.setViewportSize(mobile);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page
      .getByLabel("Account menu for Dashboard User")
      .getByRole("button", { name: "Send feedback" })
      .click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Navigation" }),
    ).toBeVisible();
  });
});
