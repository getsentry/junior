import { expect, test } from "@playwright/test";
import {
  type DashboardE2eServer,
  mockDashboardApis,
  startDashboardE2eServer,
} from "./harness";

let server: DashboardE2eServer;

test.beforeAll(async () => {
  server = await startDashboardE2eServer();
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  await mockDashboardApis(page);
});

test("opens and closes a conversation in the mobile workspace", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route("**/api/conversations/*/messages", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "slack:CQA123:1770003600.000200",
        messageId: "mobile-message",
        status: "accepted",
      },
    });
  });
  await page.goto(`${server.baseURL}/conversations`);
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  const navigationTrigger = page.getByRole("button", {
    name: "Open navigation",
  });
  await expect(navigationTrigger).toBeVisible();
  await expect(page.getByLabel("Junior home")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open profile menu for Dashboard User" }),
  ).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Conversations", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Archive Investigate checkout latency" }),
  ).toBeVisible();
  await navigationTrigger.click();
  await expect(page.getByText(/^junior version /)).toBeVisible();
  const navigationSheet = page.getByRole("dialog", { name: "Navigation" });
  const spendCallout = navigationSheet.getByLabel(
    "Personal model spend: 7 days $0.07, 30 days $0.07",
    { exact: true },
  );
  await expect(spendCallout).toBeVisible();
  await expect(spendCallout.getByText("7d $0.07")).toBeVisible();
  await expect(spendCallout.getByText("30d $0.07")).toBeVisible();
  // Spend sits above every destination, including primary nav.
  const spendAbovePrimary = await spendCallout.evaluate((node) => {
    const dialog = node.closest('[role="dialog"]');
    const primary = dialog?.querySelector('nav[aria-label="Primary"]');
    if (!dialog || !primary) return false;
    return Boolean(
      node.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(spendAbovePrimary).toBe(true);
  await expect(
    page.getByLabel("Account menu for Dashboard User"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Signed in as Dashboard User"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "My profile" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "API tokens" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  const closeNavigation = page.getByRole("button", {
    name: "Close navigation",
  });
  await expect(closeNavigation).toBeVisible();
  await closeNavigation.click();
  // Compact mobile composer needs a participant fixture.
  await page
    .getByRole("link", { name: /Investigate checkout latency/ })
    .click();
  await expect(page).toHaveURL(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );
  // One shell row: back + title + overflow. No duplicate title chrome.
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to conversations" }),
  ).toBeVisible();
  await expect(page.getByLabel("Junior home")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeHidden();
  await expect(page.getByPlaceholder("Search transcript…")).toBeHidden();
  await expect(
    page.getByRole("group", { name: "Transcript view" }),
  ).toBeHidden();
  const menu = page.getByRole("button", { name: "Conversation menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(
    page.getByRole("button", { name: "Search transcript" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Event log" })).toBeVisible();
  await expect(page.getByRole("button", { name: "App menu" })).toBeVisible();
  await page.getByRole("button", { name: "Close conversation menu" }).click();
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("1.9k tokens")).toBeHidden();
  await expect(page.getByRole("note")).toBeHidden();

  const pending = page.getByLabel("Pending messages");
  await expect(pending).toBeVisible();
  // Mobile collapsed control owns the total count.
  const expand = pending.getByRole("button", { name: "5 queued messages" });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("5 queued messages")).toHaveCount(1);
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeHidden();

  await expand.click();
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeVisible();
  await expect(
    pending.getByRole("button", { name: "Show fewer queued messages" }),
  ).toHaveAttribute("aria-expanded", "true");

  const composer = page.getByPlaceholder("Message Junior…");
  await expect(composer).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();

  const shell = page.locator("main").first();
  // Rubber-band pans can change visualViewport.offsetTop while the keyboard is
  // closed. The fixed shell must stay pinned to the layout viewport.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: window.innerHeight },
      offsetTop: { configurable: true, value: 48 },
    });
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("0px");
  await expect
    .poll(() =>
      shell.evaluate(
        (element) =>
          element.style.getPropertyValue("--dashboard-viewport-height") ===
          `${window.innerHeight}px`,
      ),
    )
    .toBe(true);

  // Keyboard open tracks height. Offset freezes while the composer is focused
  // so Safari focus pans cannot chase the fixed shell.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 140 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-height"),
      ),
    )
    .toBe("520px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("0px");

  await composer.blur();
  await page.evaluate(() => {
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("140px");

  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 180 },
    });
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("180px");
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await composer.focus();
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  // Keyboard resize keeps the latest message above the focused composer.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 480,
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  await composer.fill("Keep the mobile composer ready");
  await composer.press("Enter");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("button", { name: "Search transcript" }).click();
  await expect(page.getByPlaceholder("Search transcript…")).toBeVisible();
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("button", { name: "Event log" }).click();
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("button", { name: "Hide search" }).click();
  await expect(page.getByPlaceholder("Search transcript…")).toBeHidden();

  await page.getByRole("link", { name: "Back to conversations" }).click();
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
});
