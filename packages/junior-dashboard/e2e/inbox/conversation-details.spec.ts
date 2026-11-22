import { openRow } from "./inbox-fixture";
import { expect, test } from "../test";
import { screenshot } from "../screenshot";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("opens conversation details beside the chat", async ({
    context,
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });

    await page.goto(`${dashboard.baseURL}/?view=conversations`);

    await expect(page.getByRole("link", { name: "Junior home" })).toBeVisible();
    await expect(page).toHaveTitle(/^\(\d+\) Conversations - Junior$/);
    const list = page.getByRole("region", {
      exact: true,
      name: "Conversations",
    });
    // The lock and the status sit in the row's meta, outside its title link.
    const rowOf = (name: RegExp) =>
      list
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name }) });
    await expect(
      rowOf(/Direct Message/).getByLabel("Private conversation"),
    ).toBeVisible();
    const publicConversation = list.getByRole("link", {
      name: /Checkout latency triage/,
    });
    const publicRow = rowOf(/Checkout latency triage/);
    await expect(publicRow.getByLabel("Private conversation")).toHaveCount(0);
    await expect(
      list
        .getByRole("listitem")
        .filter({
          has: page.getByRole("link", {
            exact: true,
            name: "Investigate checkout latency",
          }),
        })
        .getByRole("status", { name: "Working" }),
    ).toBeVisible();
    await expect(
      publicRow.getByRole("status", { name: "Working" }),
    ).toHaveCount(0);
    await openRow(publicConversation);
    await expect(page).toHaveURL(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
    );
    await expect(
      page.getByRole("heading", { name: "Checkout latency triage" }),
    ).toBeVisible();
    await expect(page).toHaveTitle(
      /^\(\d+\) Checkout latency triage - Junior$/,
    );
    await expect(page.getByRole("note")).toHaveCount(0);

    const detailsButton = page.getByRole("button", {
      name: "Conversation details",
      exact: true,
    });
    const details = page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    const closeDetails = details.getByRole("button", {
      name: "Close conversation details",
      exact: true,
    });
    // Wide viewports open details beside the chat by default.
    await expect(details).toBeVisible();
    await expect(detailsButton).toBeHidden();
    const costMetric = page
      .locator('header span[tabindex="0"]')
      .filter({ hasText: /^\$0\.03$/, visible: true });
    await expect(costMetric).toBeVisible();
    // Tooltips open on keyboard focus, not on focus after a mouse click. A key
    // press first makes this a keyboard focus.
    await page.keyboard.press("Shift");
    await costMetric.focus();
    const costTooltip = page.getByRole("tooltip").filter({ hasText: /\$/ });
    await expect(costTooltip).toBeVisible();
    const tooltipId = await costTooltip.getAttribute("id");
    expect(tooltipId).toBeTruthy();
    await expect(costMetric).toHaveAttribute("aria-describedby", tooltipId!);
    await page.keyboard.press("Escape");
    await expect(costTooltip).toBeHidden();
    await expect(details).toBeVisible();

    await expect(
      details.getByRole("link", { name: /getsentry\/payments#77/ }),
    ).toHaveAttribute("href", "https://github.com/getsentry/payments/pull/77");
    await closeDetails.click();
    await expect(details).toBeHidden();
    await expect(costMetric).toBeVisible();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: dashboard.baseURL,
    });
    const conversationUrl = page.url();

    await detailsButton.press("Enter");
    await expect(details).toBeVisible();
    await expect(detailsButton).toBeHidden();
    await expect(closeDetails).toBeFocused();
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Search transcript" }).click();
    await expect(page.getByPlaceholder("Search transcript…")).toBeVisible();
    await page.getByRole("button", { name: "Close search" }).click();
    await screenshot(page, "conversation-share-details");
    // Clipboard denial must show a failure and allow another attempt.
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () =>
          Promise.reject(
            new DOMException("Clipboard denied", "NotAllowedError"),
          ),
      });
    });
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Share", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Could not copy the link" }),
    ).toBeAttached();
    await page.evaluate(() =>
      Reflect.deleteProperty(navigator.clipboard, "writeText"),
    );
    await page.getByRole("menuitem", { name: "Copy failed — retry" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Link copied" }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      conversationUrl,
    );
    await page.getByRole("button", { name: "Close conversation menu" }).click();

    // Details show memory counts. The full list replaces details in place.
    const memories = details.getByText("Use pnpm for repository commands.");
    await expect(memories).toBeHidden();
    await details
      .getByRole("button", { name: "1 recalled · 2 captured" })
      .click();
    await expect(memories).toBeVisible();
    await expect(
      details.getByRole("heading", { name: "Memories" }),
    ).toBeVisible();
    await details.getByRole("button", { name: "Back to details" }).click();
    await expect(memories).toBeHidden();
    await page.setViewportSize({ width: 1024, height: 900 });
    const sheet = page.getByRole("dialog", { name: "Conversation details" });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("link", { name: /getsentry\/payments#77/ }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(sheet).toBeHidden();
    await expect(details).toBeVisible();
    await expect(
      details.getByRole("button", { name: "Close conversation details" }),
    ).toBeFocused();
    await page.mouse.move(800, 600);
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(detailsButton).toBeFocused();
    // With the `⋯` menu open, Escape closes the menu and leaves details open.
    await detailsButton.click();
    await expect(details).toBeVisible();
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Open event log", exact: true }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Share", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menuitem", { name: "Open event log", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Conversation menu" }),
    ).toBeFocused();
    await expect(details).toBeVisible();
    await closeDetails.click();
    await expect(details).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await screenshot(page, "conversation-share-menu", { view: "mobile" });
    await page.getByRole("menuitem", { name: "Share", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Link copied" }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      conversationUrl,
    );
    await page.getByRole("button", { name: "Close conversation menu" }).click();
    await page.setViewportSize({ width: 1600, height: 900 });

    // The summary stays available after the transcript expires.
    await expect(
      page.getByText(/PAYMENTS-42 contained 418 events\./).first(),
    ).toBeVisible();

    // The view that opened the Conversation stays marked in the pane.
    await expect(
      page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Conversations", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Plugins" })).toHaveCount(0);

    await detailsButton.click();
    await expect(details).toBeVisible();
    await page.getByRole("link", { name: "Back to Conversations" }).click();
    await openRow(list.getByRole("link", { name: /Direct Message/ }));
    // Each conversation opens with details beside the chat.
    await expect(details).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Private conversation");
  });

  test("the header toggles auto archive, and details no longer show it", async ({
    dashboard,
    page,
  }) => {
    const conversationId = "slack:CQA123:1770003600.000200";
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
    );
    const details = page.getByRole("complementary", {
      exact: true,
      name: "Conversation details",
    });
    await expect(details).toBeVisible();
    await expect(details.getByText("Auto archive")).toHaveCount(0);

    const toggle = page.getByRole("button", { name: "Auto archive" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // Tooltips open on keyboard focus, not on focus after a mouse click.
    await page.keyboard.press("Shift");
    await toggle.focus();
    await expect(page.getByRole("tooltip")).toContainText(
      "Auto archive is off",
    );

    const save = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/auto-archive"),
    );
    await toggle.press("Enter");
    expect((await save).postDataJSON()).toEqual({ autoArchive: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("tooltip")).toContainText("Auto archive is on");
    await screenshot(page, "conversation-header-auto-archive", {
      lightTheme: true,
    });

    // A phone shows the toggle in the app header, beside the menu.
    await page.setViewportSize({ height: 844, width: 390 });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Touch opens no tooltip, so the help is the accessible description.
    await expect(toggle).toHaveAccessibleDescription(/linked work is merged/);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("shows a Watch on linked work in its linked work row", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
    );
    const details = page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    const watched = details.getByRole("link", {
      name: /getsentry\/getsentry#21572/,
    });
    // The watched pull request is linked work, so it shows once.
    await expect(watched).toHaveCount(1);
    await expect(details.getByText("Also waiting on")).toBeVisible();
    await expect(
      details.getByRole("link", {
        name: /^Reply to new review comments on the PR\. expires/,
      }),
    ).toBeVisible();

    await details
      .getByRole("button", { name: "Details for getsentry/getsentry#21572" })
      .click();
    await expect(
      details.getByText(
        "Fix failing checks and address requested changes on the dashboard PR.",
      ),
    ).toBeVisible();
    await screenshot(page, "conversation-details-watched-linked-work");
  });

  test("keeps memories out of the transcript and jumps to their Turn", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
    );

    const details = page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    await details
      .getByRole("button", { name: "1 recalled · 2 captured" })
      .click();
    const captured = details
      .getByRole("listitem")
      .filter({ hasText: "Use pnpm for repository commands." });
    await expect(captured).toBeVisible();
    await expect(captured.getByRole("img", { name: "Private" })).toBeVisible();
    // The transcript shows no memory chips or capture rows.
    await expect(page.getByText(/^(Captured|Recalled) \d+ memor/)).toHaveCount(
      0,
    );

    // A memory jump shows its Turn, even when a search hides that row.
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Search transcript" }).click();
    await page.getByPlaceholder("Search transcript…").fill("no such text");
    await details
      .getByRole("listitem")
      .filter({ hasText: "Dashboard transcript events should remain" })
      .getByRole("button", { name: "Go to message" })
      .click();
    await expect(
      page
        .getByLabel("Conversation transcript")
        .locator("[data-transcript-seq][data-highlighted]"),
    ).toBeInViewport();
    await screenshot(page, "conversation-memory-list");
  });
});
