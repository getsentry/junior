import { expect, test } from "./test";
import { screenshot } from "./screenshot";

const SPEND_LABEL = "Personal model spend: 7 days $0.46, 30 days $0.46";

test("shows the primary destinations at the top of every desktop pane", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(dashboard.baseURL);

  const primary = page.getByRole("navigation", { name: "Primary" });
  const destinations = primary.getByRole("link");
  // Inbox comes first and carries the To do count.
  await expect(destinations).toHaveCount(2);
  await expect(destinations.nth(0)).toHaveAccessibleName(
    /^Inbox, \d+ waiting$/,
  );
  await expect(destinations.nth(1)).toHaveAccessibleName("Automations");
  await expect(destinations.nth(0)).toHaveAttribute("aria-current", "page");
  // The pane is one column: destinations above the Inbox entries.
  await expect(page.getByRole("navigation", { name: "Inbox" })).toBeVisible();

  // Automations puts its own list under the same destinations.
  await primary.getByRole("link", { name: "Automations" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
  await expect(
    primary.getByRole("link", { name: "Automations" }),
  ).toHaveAttribute("aria-current", "page");
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

test("collapses the other tabs to icons in a narrow pane", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(dashboard.baseURL);
  const primary = page.getByRole("navigation", { name: "Primary" });
  const inbox = primary.getByRole("link", { name: /^Inbox, \d+ waiting$/ });
  const automations = primary.getByRole("link", { name: "Automations" });

  await page.getByRole("separator", { name: "Resize sidebar" }).focus();
  // Each arrow press moves the pane edge 16px.
  for (let step = 0; step < 5; step += 1)
    await page.keyboard.press("ArrowRight");
  await expect(automations.getByText("Automations")).toBeVisible();

  for (let step = 0; step < 15; step += 1)
    await page.keyboard.press("ArrowLeft");
  // The tab in view keeps its label; the others keep their name as tooltip.
  await expect(inbox.getByText("Inbox")).toBeVisible();
  await expect(automations.getByText("Automations")).toBeHidden();
  await automations.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Automations");

  // An icon-only Inbox keeps its count.
  await automations.click();
  await expect(automations).toHaveAttribute("aria-current", "page");
  await expect(automations.getByText("Automations")).toBeVisible();
  await expect(inbox.getByText("Inbox")).toBeHidden();
  await expect(inbox.getByText(/^\d+$/)).toBeVisible();
});

test("names New after the tab that shows", async ({ page, dashboard }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [path, name] of [
    ["/", "New conversation"],
    ["/review", "New conversation"],
    ["/automations", "New automation"],
  ] as const) {
    await page.goto(`${dashboard.baseURL}${path}`);
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
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
  const entries = page.getByRole("navigation", { name: "Inbox" });
  await expect(entries).toBeHidden();

  // Cmd/Ctrl+B shows it again.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(primary).toBeVisible();
  await expect(entries).toBeVisible();
});

test("reopens each tab where the reader left it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${dashboard.baseURL}/automations/runs`);
  const primary = page.getByRole("navigation", { name: "Primary" });
  const tab = (name: string) =>
    primary.getByRole("link", { exact: true, name });

  await primary.getByRole("link", { name: /^Inbox/ }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await tab("Automations").click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations/runs`);
  // A press on the tab that shows goes back to its top level.
  await tab("Automations").click();
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
    .getByRole("link", { name: /Checkout latency triage/ });
  await expect(row.getByRole("img", { name: "Brief: Done" })).toBeVisible();
  const summary = row.getByText(/traced to payments-v42/);
  await expect(summary).toHaveClass(/line-clamp-1/);

  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("button", { name: "Comfortable density" }).click();
  await expect(root).toHaveAttribute("data-density", "comfortable");
  await expect(summary).toHaveClass(/line-clamp-2/);
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
  const title = page.getByRole("heading", { name: "Checkout latency triage" });
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
  const pageLinks = page.getByRole("navigation", { name: "System navigation" });
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
