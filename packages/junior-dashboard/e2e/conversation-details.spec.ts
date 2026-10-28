import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("opens conversation details beside the chat", async ({
  context,
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });

  await page.goto(dashboard.baseURL);

  await expect(page.getByRole("link", { name: "Junior home" })).toBeVisible();
  await expect(page).toHaveTitle("Junior");
  await expect(
    page.getByRole("region", { name: "Conversations" }),
  ).toBeVisible();
  const privateConversation = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Direct Message" }) });
  await expect(
    privateConversation.getByLabel("Private conversation"),
  ).toBeVisible();
  const publicConversation = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Checkout latency triage" }),
  });
  await expect(
    publicConversation.getByLabel("Private conversation"),
  ).toHaveCount(0);
  await publicConversation.getByText("41 minutes ago", { exact: true }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770000000.000100")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Checkout latency triage - Junior");
  await expect(page.getByRole("note")).toContainText("Public conversation");
  await expect(page.getByRole("note")).toContainText("Public");

  const costMetric = page
    .getByRole("main")
    .locator('span[tabindex="0"]')
    .filter({ hasText: /^\$0\.03$/ });
  await expect(costMetric).toHaveCount(1);
  await costMetric.focus();
  // Scope past sidebar linked-work tooltips that can stay open on the selected row.
  const costTooltip = page.getByRole("tooltip").filter({ hasText: /\$/ });
  await expect(costTooltip).toBeVisible();
  const tooltipId = await costTooltip.getAttribute("id");
  expect(tooltipId).toBeTruthy();
  await expect(costMetric).toHaveAttribute("aria-describedby", tooltipId!);
  await page.keyboard.press("Escape");
  await expect(costTooltip).toBeHidden();

  await expect(
    page.getByLabel("Linked work", { exact: true }).getByRole("link").first(),
  ).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: dashboard.baseURL,
  });
  const conversationUrl = page.url();

  const detailsButton = page.getByRole("button", {
    name: "Conversation details",
    exact: true,
  });
  await detailsButton.click();
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await expect(details).toBeVisible();
  await page.getByRole("button", { name: "Search transcript" }).click();
  await expect(page.getByPlaceholder("Search transcript…")).toBeVisible();
  await page.getByRole("button", { name: "Hide search" }).click();
  await detailsButton.click();
  await expect(details).toBeHidden();
  await detailsButton.click();
  await expect(
    details.getByRole("tabpanel", { name: "Summary", exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("link", { name: /getsentry\/payments#77/ }),
  ).toHaveAttribute("href", "https://github.com/getsentry/payments/pull/77");
  await screenshot(page, "conversation-share-details");
  // Clipboard denial must show a failure and allow another attempt.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () =>
        Promise.reject(new DOMException("Clipboard denied", "NotAllowedError")),
    });
  });
  await details.getByRole("button", { name: "Share", exact: true }).click();
  await expect(details.getByRole("status")).toContainText(
    "Could not copy the link",
  );
  await page.evaluate(() =>
    Reflect.deleteProperty(navigator.clipboard, "writeText"),
  );
  await details.getByRole("button", { name: "Copy failed — retry" }).click();
  await expect(
    details.getByRole("button", { name: "Link copied" }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    conversationUrl,
  );

  const summaryTab = details.getByRole("tab", { name: "Summary", exact: true });
  const memoriesTab = details.getByRole("tab", { name: "Memories" });
  await summaryTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(memoriesTab).toBeFocused();
  await expect(memoriesTab).toHaveAttribute("aria-selected", "true");
  await expect(
    details.getByRole("tabpanel", { name: "Memories" }),
  ).toContainText("Use pnpm for repository commands.");
  await page.setViewportSize({ width: 1024, height: 900 });
  const sheet = page.getByRole("dialog", { name: "Conversation details" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("tab", { name: "Memories" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(sheet).toBeHidden();
  await expect(details).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Close conversation details" }),
  ).toBeFocused();
  await details.getByRole("tab", { name: "Memories" }).focus();
  await page.keyboard.press("Home");
  await expect(summaryTab).toBeFocused();
  await expect(summaryTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(detailsButton).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await screenshot(page, "conversation-share-menu", { view: "mobile" });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
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
    page.getByRole("link", { name: "Conversations" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Plugins" })).toHaveCount(0);

  await detailsButton.click();
  await expect(details).toBeVisible();
  await page
    .getByRole("navigation", { name: "Your conversations" })
    .getByRole("link", { name: /Direct Message/ })
    .click();
  await expect(details).toBeHidden();
  await expect(page.getByRole("note")).toContainText("Private conversation");
  await expect(page.getByRole("note")).toContainText("Private");
});
