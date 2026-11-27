import { conversationMenuRow } from "./conversationMenu";
import { openRow } from "./inbox-fixture";
import { expect, test } from "../test";
import { mobile, screenshot } from "../screenshot";

test.describe("new UI", () => {
  test("opens conversation details beside the chat", async ({
    context,
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });

    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);

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
    // Live cost leads the details, not the header.
    const costMetric = details
      .locator('span[tabindex="0"]')
      .filter({ hasText: /^\$0\.03$/ });
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
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: dashboard.baseURL,
    });
    const conversationUrl = page.url();

    await detailsButton.press("Enter");
    await expect(details).toBeVisible();
    await expect(detailsButton).toBeHidden();
    await expect(closeDetails).toBeFocused();
    await page
      .getByRole("button", { name: "Search transcript", exact: true })
      .click();
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

    // A phone shows the menu as a bottom sheet.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Conversation menu" }).click();
    const menuSheet = page.getByRole("dialog", {
      name: "Checkout latency triage",
    });
    await screenshot(page, "conversation-share-menu", { view: "mobile" });
    await menuSheet.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      menuSheet.getByRole("button", { name: "Link copied" }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      conversationUrl,
    );
    await menuSheet.getByRole("button", { name: "Cancel" }).click();
    await expect(menuSheet).toBeHidden();
    await page.setViewportSize({ width: 1600, height: 900 });

    // The summary stays available after the transcript expires.
    await expect(
      page.getByText(/PAYMENTS-42 contained 418 events\./).first(),
    ).toBeVisible();

    // The view that opened the Conversation stays marked in the pane, as
    // the list the page is in.
    await expect(
      page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Conversations", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("link", { name: "Plugins" })).toHaveCount(0);

    await detailsButton.click();
    await expect(details).toBeVisible();
    await page.getByRole("link", { name: "Back to Conversations" }).click();
    await openRow(list.getByRole("link", { name: /Direct Message/ }));
    // Each conversation opens with details beside the chat.
    await expect(details).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Private conversation");
    // The viewer is not a participant, so the dock says why there is no
    // reply box.
    await expect(
      page.getByText("Only participants can reply to a private conversation."),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Continue this conversation" }),
    ).toHaveCount(0);
    // Only an Invite lets them in, so the menu offers no Join.
    await page.getByRole("button", { name: "Conversation menu" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Share" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Join" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("a reader of a public conversation joins it to reply", async ({
    page,
    dashboard,
  }) => {
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA456:1770025200.000700")}`,
    );
    const composer = page.getByRole("textbox", {
      name: "Continue this conversation",
    });
    const join = page.getByRole("button", { name: "Join", exact: true });
    // Only a Participant posts, so the dock offers Join instead.
    await expect(join).toBeVisible();
    await expect(composer).toHaveCount(0);

    const joined = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith("/subscription"),
    );
    await join.click();
    expect((await joined).request().postDataJSON()).toEqual({
      subscribed: true,
    });
    await expect(composer).toBeVisible();
    await expect(join).toHaveCount(0);
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

  test("lists To-dos, and a Participant changes their status", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
    );
    const details = page.getByRole("complementary", {
      exact: true,
      name: "Conversation details",
    });
    // The heading counts the open and in-progress To-dos.
    const heading = details.getByRole("heading", { name: /^To-dos/ });
    await expect(heading).toHaveText("To-dos3");
    const change = page.getByRole("button", {
      name: "Change Confirm the rollback window",
    });
    const rollback = details.getByRole("listitem").filter({ has: change });
    await expect(rollback.getByRole("img", { name: "Open" })).toBeVisible();
    await screenshot(page, "conversation-details-todos", {
      lightTheme: true,
      target: details,
      view: "desktop",
    });

    await change.click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Start",
      "Mark done",
      "Drop",
    ]);
    const save = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/todos/13"),
    );
    await page.getByRole("menuitem", { name: "Mark done" }).click();
    expect((await save).postDataJSON()).toEqual({ status: "done" });
    await expect(rollback.getByRole("img", { name: "Done" })).toBeVisible();
    await expect(heading).toHaveText("To-dos2");

    await change.click();
    await page.getByRole("menuitem", { name: "Reopen" }).click();
    await expect(rollback.getByRole("img", { name: "Open" })).toBeVisible();

    // A phone shows the same card in the details sheet.
    await page.setViewportSize({ height: 844, width: 390 });
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await conversationMenuRow(page, "Conversation details").click();
    const sheetHeading = page
      .getByRole("dialog", { name: "Conversation details" })
      .getByRole("heading", { name: /^To-dos/ });
    await sheetHeading.scrollIntoViewIfNeeded();
    await expect(sheetHeading).toBeInViewport();
    await screenshot(page, "conversation-details-todos", {
      lightTheme: true,
      view: "mobile",
    });
  });

  test("a viewer who is not a Participant sees To-dos without actions", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
    );
    const details = page.getByRole("complementary", {
      exact: true,
      name: "Conversation details",
    });
    await expect(
      details.getByText("Fix the failing dashboard checks"),
    ).toBeVisible();
    await expect(details.getByRole("button", { name: /^Change / })).toHaveCount(
      0,
    );
  });

  test("on a phone, an Inbox item in the details opens in its own sheet", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(mobile);
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:questions-qa")}`,
    );
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await conversationMenuRow(page, "Conversation details").click();
    const details = page.getByRole("dialog", { name: "Conversation details" });
    await details
      .getByRole("region", { name: "Inbox" })
      .getByRole("button", { name: "Handle the negative invoices" })
      .click();
    // The item does not open in place in the details, but over them.
    const item = page.getByRole("dialog", {
      name: "Handle the negative invoices",
    });
    await expect(item.getByRole("button", { name: "Skip them" })).toBeVisible();
    await expect(
      details.getByRole("button", { name: "Skip them" }),
    ).toHaveCount(0);
    await screenshot(page, "conversation-details-inbox-item", {
      lightTheme: true,
      view: "mobile",
    });

    // Back goes back to the details.
    await item.getByRole("button", { exact: true, name: "Back" }).click();
    await expect(item).toHaveCount(0);
    await expect(details).toBeVisible();
  });

  test("on a phone, memories and Tasks open one step deeper in the details sheet", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(mobile);
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
    );
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await conversationMenuRow(page, "Conversation details").click();
    const details = page.getByRole("dialog", { name: "Conversation details" });
    const memoryCard = details.getByRole("button", {
      name: "1 recalled · 2 captured",
    });

    // Memories replace details in the sheet, with a way back.
    await memoryCard.click();
    const memories = page.getByRole("dialog", { name: "Memories" });
    await expect(
      memories.getByRole("button", { name: "Back to details" }),
    ).toBeVisible();
    await screenshot(page, "conversation-details-memories", {
      view: "mobile",
    });
    await memories.getByRole("button", { name: "Back to details" }).click();
    await expect(memoryCard).toBeVisible();

    // A Task opens over the details, and Back goes back to them.
    const reviewerRow = details
      .getByRole("region", { name: "Tasks" })
      .getByRole("button", { name: /^blocked reviewer/ });
    await reviewerRow.click();
    const reviewer = page.getByRole("dialog", { name: "reviewer" });
    await expect(
      reviewer.getByRole("link", { name: "Open conversation" }),
    ).toBeVisible();
    await screenshot(page, "conversation-details-task", { view: "mobile" });
    await reviewer.getByRole("button", { exact: true, name: "Back" }).click();
    await expect(reviewer).toHaveCount(0);
    await expect(details).toBeVisible();

    // Its close button shuts the Task and the details together.
    await reviewerRow.click();
    await reviewer.getByRole("button", { name: "Close transcript" }).click();
    await expect(reviewer).toHaveCount(0);
    await expect(details).toHaveCount(0);
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
    await page
      .getByRole("button", { name: "Search transcript", exact: true })
      .click();
    await page.getByPlaceholder("Search transcript…").fill("no such text");
    await details
      .getByRole("listitem")
      .filter({ hasText: "Dashboard transcript events should remain" })
      .getByRole("button", { name: "Go to message" })
      .click();
    const highlighted = page
      .getByLabel("Conversation transcript")
      .locator("[data-transcript-seq][data-highlighted]");
    await expect(highlighted).toBeInViewport();
    // The mark lasts a moment, so it can end between the desktop and the
    // mobile capture. Shoot after it ends.
    await expect(highlighted).toHaveCount(0);
    await screenshot(page, "conversation-memory-list");
  });
});
