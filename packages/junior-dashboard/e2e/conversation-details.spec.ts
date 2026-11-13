import { openRow } from "./inbox-fixture";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";

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
      .getByRole("status", { name: "Running" }),
  ).toBeVisible();
  await expect(publicRow.getByRole("status", { name: "Running" })).toHaveCount(
    0,
  );
  await openRow(publicConversation);
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/^\(\d+\) Checkout latency triage - Junior$/);
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
        Promise.reject(new DOMException("Clipboard denied", "NotAllowedError")),
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

  // The full durable Brief stays available after the transcript expires.
  await page.getByText("Facts, links & keywords", { exact: true }).click();
  await expect(
    page.getByText("PAYMENTS-42 contained 418 events."),
  ).toBeVisible();

  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ }),
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
    details.getByRole("link", { name: /getsentry\/junior#2351/ }),
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

test("shows recalled and captured memories in popovers", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
  );

  // Captured memories stay out of the collapsed activity rows.
  const captured = page.getByRole("button", { name: "Captured 2 memories" });
  await expect(captured).toBeVisible();
  await captured.click();
  const capturedPopover = page.getByRole("dialog", {
    name: "Captured 2 memories",
  });
  await expect(
    capturedPopover.getByText("Use pnpm for repository commands."),
  ).toBeVisible();
  await expect(
    capturedPopover.getByRole("img", { name: "Private" }),
  ).toBeVisible();
  await screenshot(page, "conversation-captured-memories-popover");
  await page.keyboard.press("Escape");
  await expect(capturedPopover).toBeHidden();

  // A memory in details opens its Turn's popover in the transcript, even
  // when a search hides that row.
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("menuitem", { name: "Search transcript" }).click();
  await page.getByPlaceholder("Search transcript…").fill("no such text");
  await expect(captured).toBeHidden();
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await details
    .getByRole("button", { name: "1 recalled · 2 captured" })
    .click();
  await details
    .getByRole("listitem")
    .filter({ hasText: "Dashboard transcript events should remain" })
    .getByRole("button", { name: "Go to message" })
    .click();
  await expect(capturedPopover).toBeVisible();
  await expect(
    details.getByRole("heading", { name: "Memories" }),
  ).toBeVisible();
  await screenshot(page, "conversation-memory-list-jump");
});

test("shows recalled memories under their prompt", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );

  const recalled = page.getByRole("button", { name: "Recalled 1 memory" });
  await recalled.click();
  const popover = page.getByRole("dialog", { name: "Recalled 1 memory" });
  await expect(
    popover.getByText(
      "Checkout latency investigations start with the deployment comparison dashboard.",
    ),
  ).toBeVisible();
  await expect(
    popover.getByRole("link", { name: /^Checkout latency investigations/ }),
  ).toHaveAttribute("href", "/memories/memory-checkout-runbook");
  await screenshot(page, "conversation-recalled-memories-popover");
  await recalled.click();
  await expect(popover).toBeHidden();
});
