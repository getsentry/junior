import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("shows the primary destinations at the top of every desktop pane", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(dashboard.baseURL);

  const primary = page.getByRole("navigation", { name: "Primary" });
  const destinations = primary.getByRole("link");
  // Inbox carries the open review item count.
  await expect(destinations).toHaveText([
    "Conversations",
    /^Inbox\d+$/,
    "Automations",
  ]);
  await expect(
    primary.getByRole("link", { name: "Conversations" }),
  ).toHaveAttribute("aria-current", "page");
  // The pane is one column: destinations above the conversation list.
  await expect(
    page.getByRole("navigation", { name: "Your conversations" }),
  ).toBeVisible();

  // Inbox puts its own list under the same destinations.
  await primary.getByRole("link", { name: "Inbox" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/review`);
  await expect(primary.getByRole("link", { name: "Inbox" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByPlaceholder("Search items…")).toBeVisible();

  // Pages without a list get the destinations alone.
  await primary.getByRole("link", { name: "Automations" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/automations`);
  await expect(
    primary.getByRole("link", { name: "Automations" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", {
      name: "Open profile menu for Dashboard User",
      exact: true,
    }),
  ).toBeVisible();
  await screenshot(page, "navigation-pane-automations", { view: "desktop" });
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

  // The choice survives a reload and a move to another page.
  await page.reload();
  await expect(primary).toBeHidden();
  await page.goto(dashboard.baseURL);
  await expect(primary).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Your conversations" }),
  ).toBeHidden();

  // Cmd/Ctrl+B shows it again.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(primary).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Your conversations" }),
  ).toBeVisible();
});
