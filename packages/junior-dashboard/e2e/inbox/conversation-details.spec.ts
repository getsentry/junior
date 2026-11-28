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

    // Merged work waits behind "Show finished". The ref drops the repo that
    // the conversation works in.
    const linkedWork = details.getByRole("region", { name: "Linked work" });
    const merged = linkedWork.getByRole("link", {
      name: /#77 Cache tax rates/,
    });
    await expect(merged).toHaveCount(0);
    await linkedWork.getByRole("button", { name: "Show finished" }).click();
    await expect(merged).toHaveAttribute(
      "href",
      "https://github.com/getsentry/payments/pull/77",
    );
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
      .getByRole("button", { name: "Memories", exact: true })
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
    const sheetLinks = sheet.getByRole("region", { name: "Linked work" });
    await sheetLinks.getByRole("button", { name: "Show finished" }).click();
    await expect(sheetLinks.getByRole("link", { name: /#77 / })).toBeVisible();
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

  test("lists Watches in Waiting on and linked work once", async ({
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
    // The watched pull request is linked work, so it shows once, and its
    // Watch waits with its expiry and a separate link out.
    await expect(
      details
        .getByRole("region", { name: "Linked work" })
        .getByRole("link", { name: /#21572/ }),
    ).toHaveCount(1);
    const watch = details
      .getByRole("region", { exact: true, name: "Waiting on" })
      .getByRole("listitem")
      .filter({
        hasText:
          "Fix failing checks and address requested changes on the dashboard PR.",
      });
    await expect(watch).toContainText(/Expires /);
    await expect(
      watch.getByRole("link", {
        name: "Open Fix failing checks and address requested changes on the dashboard PR.",
      }),
    ).toHaveAttribute("href", /\/pull\/21572/);
    // What blocks work leads. To-dos only inform, so they come last.
    await expect(details.getByRole("heading", { level: 3 })).toHaveText([
      "Agents",
      "Waiting on",
      "To-dos",
      "Linked work",
    ]);
    await screenshot(page, "conversation-details-watched-linked-work");
  });

  test("lists To-dos with their owners, and a Participant changes their status", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
    );
    const work = page
      .getByRole("complementary", { exact: true, name: "Conversation details" })
      .getByRole("region", { exact: true, name: "To-dos" });
    // To-dos have no count: closed To-dos are only the latest few.
    await expect(work.getByRole("heading")).toHaveText("To-dos");
    // A child agent's To-do stays out: Agents shows that child.
    await expect(work.getByText("Compare p95 with last week")).toHaveCount(0);
    const change = page.getByRole("button", {
      name: "Change Confirm the rollback window",
    });
    const rollback = work.getByRole("listitem").filter({ has: change });
    await expect(
      rollback.getByRole("img", { name: "Not started" }),
    ).toBeVisible();
    // Each To-do names its owner before its notes. The viewer's own To-do
    // says "You".
    await expect(rollback).toContainText("You · Check the deploy calendar");
    await screenshot(page, "conversation-details-todos", {
      lightTheme: true,
      target: work,
      view: "desktop",
    });

    // A started To-do can go back to not started.
    await page
      .getByRole("button", { name: "Change Find the slow checkout span" })
      .click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Mark done",
      "Mark not started",
      "Drop",
    ]);
    await page.keyboard.press("Escape");

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
    // A finished To-do waits behind "Show finished".
    await expect(rollback).toHaveCount(0);
    await work.getByRole("button", { name: "Show finished" }).click();
    await expect(rollback.getByRole("img", { name: "Done" })).toBeVisible();

    await change.click();
    await page.getByRole("menuitem", { name: "Reopen" }).click();
    await expect(
      rollback.getByRole("img", { name: "Not started" }),
    ).toBeVisible();

    // A phone shows the same section in the details sheet.
    await page.setViewportSize({ height: 844, width: 390 });
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await conversationMenuRow(page, "Conversation details").click();
    const sheetHeading = page
      .getByRole("dialog", { name: "Conversation details" })
      .getByRole("heading", { name: "To-dos", exact: true });
    await sheetHeading.scrollIntoViewIfNeeded();
    await expect(sheetHeading).toBeInViewport();
    await screenshot(page, "conversation-details-todos", {
      lightTheme: true,
      view: "mobile",
    });
  });

  test("an Agents row menu cancels the child's Watch and archives the child", async ({
    dashboard,
    page,
  }) => {
    const parentId = "junior:internal:dashboard-qa:thread";
    const childId = "junior:internal:dashboard-qa:thread:nested";
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(parentId)}`,
    );
    const agents = page
      .getByRole("complementary", { exact: true, name: "Conversation details" })
      .getByRole("region", { exact: true, name: "Agents" });
    const child = agents
      .getByRole("listitem")
      .filter({ hasText: "Recheck pin order in Safari" });
    const menu = child.getByRole("button", {
      name: "Change Recheck pin order in Safari",
    });
    // The child's run is done, so it waits behind "Show finished".
    await agents.getByRole("button", { name: "Show finished" }).click();
    await expect(child.getByRole("img", { name: "Done" })).toBeVisible();

    // Only the child cancels its own Watch, so the cancel goes to its route.
    await menu.click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Cancel Recheck in Safari when the preview deploy is ready.",
      "Archive",
    ]);
    const cancel = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url() ===
          `${dashboard.baseURL}/api/conversations/${encodeURIComponent(childId)}/watches/watch-thread-child`,
    );
    await page
      .getByRole("menuitem", {
        name: "Cancel Recheck in Safari when the preview deploy is ready.",
      })
      .click();
    expect((await cancel).status()).toBe(204);
    await menu.click();
    await expect(page.getByRole("menuitem")).toHaveText(["Archive"]);

    // Archive is for everyone, so it asks first.
    const archive = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url() ===
          `${dashboard.baseURL}/api/conversations/${encodeURIComponent(childId)}/archive`,
    );
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page
      .getByRole("alertdialog", { name: "Archive for everyone?" })
      .getByRole("button", { name: "Archive" })
      .click();
    const archived = await archive;
    expect(archived.ok()).toBe(true);
    expect(archived.request().postDataJSON()).toMatchObject({
      applyToChildren: true,
      archived: true,
    });
    // An archived child stays listed, with nothing left to change.
    await expect(menu).toHaveCount(0);
    await expect(child.getByRole("img", { name: "Done" })).toBeVisible();
  });

  test("Needs you lists a child's Inbox items on its parent", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA456:1770028800.000900")}`,
    );
    const details = page.getByRole("complementary", {
      exact: true,
      name: "Conversation details",
    });
    // A child's ask blocks its parent's work, so the parent shows it, with
    // the child's name.
    const card = details
      .getByRole("region", { name: "Needs you" })
      .getByRole("button", { name: /Pause canary rollouts/ });
    await expect(card).toContainText(
      /Question for you · Check the last ten Sentaur pipeline runs · /,
    );
    // The child keeps its row in Agents, waiting on the viewer.
    await expect(
      details
        .getByRole("region", { exact: true, name: "Agents" })
        .getByRole("listitem")
        .filter({ hasText: "Check the last ten Sentaur pipeline runs" })
        .getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    await card.click();
    await expect(
      page
        .getByRole("dialog")
        .getByText("Pause canary rollouts until #418 lands?"),
    ).toBeVisible();
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
      .getByRole("region", { name: "Needs you" })
      .getByRole("button", { name: /Handle the negative invoices/ })
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

  test("a Needs you card opens its Inbox item in a dialog that acting closes", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:questions-qa")}`,
    );
    const needsYou = page
      .getByRole("complementary", { exact: true, name: "Conversation details" })
      .getByRole("region", { name: "Needs you" });
    const card = needsYou.getByRole("button", {
      name: /Handle the negative invoices/,
    });
    await card.click();
    const item = page.getByRole("dialog", {
      name: "Handle the negative invoices",
    });
    await expect(item.getByRole("button", { name: "Skip them" })).toBeVisible();
    await item.getByRole("button", { exact: true, name: "Dismiss" }).click();
    await expect(item).toHaveCount(0);
    await expect(card).toHaveCount(0);
  });

  test("a review link opens the only Needs you item with its action", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}?review=open`,
    );
    // A To do for you opens with its related links and Mark done.
    const item = page.getByRole("dialog", {
      name: "Approve the preview deploy",
    });
    await expect(
      item.getByRole("link", { name: /Dashboard QA preview/ }),
    ).toBeVisible();
    await item.getByRole("button", { exact: true, name: "Mark done" }).click();
    await expect(item).toHaveCount(0);
  });

  test("an Automation run names its Automation above the summary", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("scheduler:daily-ops-digest")}`,
    );
    const details = page.getByRole("complementary", {
      exact: true,
      name: "Conversation details",
    });
    await expect(
      details.getByRole("link", {
        exact: true,
        name: "Automation: Weekly project summary",
      }),
    ).toHaveAttribute("href", "/automations/scheduled-1");
    // Its full instruction stays on the Automation page.
    await expect(
      details.getByText(/Send the weekly project summary/),
    ).toHaveCount(0);
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
      exact: true,
      name: "Memories",
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
      .getByRole("region", { exact: true, name: "Agents" })
      .getByRole("button", { name: /^Blocked reviewer/ });
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
      .getByRole("button", { name: "Memories", exact: true })
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
