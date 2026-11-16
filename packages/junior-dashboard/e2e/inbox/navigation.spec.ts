import { mockAutomationCollection } from "../../src/mock-reporting/automation-collection";
import { automationReport } from "./automation-fixture";
import { startDashboardE2eServer } from "../harness";
import { mockReviewItems } from "./inbox-fixture";
import { expect, test } from "../test";
import { screenshot } from "../screenshot";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const SPEND_LABEL = "Personal model spend: 7 days $0.46, 30 days $0.46";

  test("shows the primary destinations at the top of every desktop pane", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(dashboard.baseURL);

    const primary = page.getByRole("navigation", { name: "Primary" });
    // One list of labelled rows: the Inbox views, Conversations and
    // Automations, then the asks by type. No tab bar sits above them.
    await expect(page.getByRole("tablist")).toHaveCount(0);
    const rows = primary.getByRole("link");
    const names = [
      /^Inbox, \d+ waiting$/,
      "Snoozed",
      "Done",
      "Conversations",
      /^Automations/,
      /^Pull requests/,
      /^Decisions/,
    ];
    for (const [index, name] of names.entries())
      await expect(rows.nth(index)).toHaveAccessibleName(name);
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "page");
    await expect(
      primary.getByRole("heading", { name: "Asks by type" }),
    ).toBeVisible();

    // Automations keeps the same pane, with its row marked.
    await primary.getByRole("link", { name: /^Automations/ }).click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
    await expect(
      primary.getByRole("link", { name: /^Automations/ }),
    ).toHaveAttribute("aria-current", "page");
    await expect(rows.nth(0)).toHaveAccessibleName(/^Inbox, \d+ waiting$/);
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
    expect(startWidth).toBe(256);
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(paneWidth).toBe(startWidth + 32);
    await primary.getByRole("link", { name: /^Inbox/ }).click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
    await expect.poll(paneWidth).toBe(startWidth + 32);
    await page.reload();
    await expect.poll(paneWidth).toBe(startWidth + 32);
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
    await mockReviewItems(page, {
      automations: () =>
        mockAutomationCollection(
          report,
          new URLSearchParams({ owner: "me", scope: "attention" }),
        ).total,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(dashboard.baseURL);
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
    await page.goto(`${dashboard.baseURL}/automations/runs`);
    await expect(automations).toHaveAttribute("aria-current", "page");
    await expect(primary.getByRole("link", { name: /^Inbox/ })).toBeVisible();
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
    await expect(inbox).toHaveAttribute("href", "/");
    // The old link would bounce the reader back to Automations.
    await inbox.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
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
    await expect(page).toHaveURL(`${dashboard.baseURL}/?view=conversations`);
  });

  test("names New after the page that shows", async ({ page, dashboard }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [path, name] of [
      ["/", "New conversation"],
      ["/review", "New conversation"],
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
    await expect(page.getByLabel("Start a conversation")).toHaveValue(
      /^Set up an automation that /,
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
    await page.goto(dashboard.baseURL);
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
    await automations.click();
    await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);

    // The pane's search bar opens the command palette.
    await page.getByRole("button", { name: /^Search/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Go to conversation" }),
    ).toBeVisible();
  });

  test("keeps the density choice", async ({ page, dashboard }) => {
    const root = page.locator("html");
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    await expect(root).toHaveAttribute("data-density", "compact");
    // A row with a Brief shows its status; Comfortable gives its summary
    // more lines.
    const row = page
      .getByRole("region", { exact: true, name: "Conversations" })
      .getByRole("listitem")
      .filter({
        has: page.getByRole("link", { name: /Checkout latency triage/ }),
      });
    await expect(row.getByRole("img", { name: "Brief: Done" })).toBeVisible();
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
    await expect(summary).toHaveClass(/line-clamp-3/);
    await page.reload();
    await expect(root).toHaveAttribute("data-density", "comfortable");
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
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Zen mode" }).click();
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
      await page.goto(dashboard.baseURL);
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
});
