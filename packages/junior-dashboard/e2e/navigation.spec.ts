import { expect, test } from "./test";

test("expands the nav sidebar and keeps the choice", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(dashboard.baseURL);

  const sidebar = page.locator('[data-slot="sidebar"]').filter({
    has: page.getByRole("navigation", { name: "Primary" }),
  });
  const profile = sidebar.getByRole("button", {
    name: "Open profile menu for Dashboard User",
    exact: true,
  });
  // The sidebar starts as the icon rail, with only the avatar.
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(profile).not.toContainText("Dashboard User", {
    useInnerText: true,
  });

  // An expanded sidebar adds labels, and the choice survives a reload.
  await sidebar.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(profile).toContainText("Dashboard User", {
    useInnerText: true,
  });
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");

  // Narrower desktop windows keep the choice and the toggle.
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(
    sidebar.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();
});

test("shows usage against the soft caps in the sidebar and top bar", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(dashboard.baseURL);

  const sidebar = page.locator('[data-slot="sidebar"]').filter({
    has: page.getByRole("navigation", { name: "Primary" }),
  });
  const usage = page.getByRole("button", {
    name: "Usage: <1% of weekly soft cap. 7 days $0.46, 30 days $0.46.",
  });
  // The collapsed sidebar shows only the ring.
  await expect(usage.locator("[data-usage-ring]")).toBeVisible();
  await expect(usage.locator("[data-usage-totals]")).toBeHidden();
  await sidebar.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(usage).toContainText(/7d\s*\$0\.46\s*·\s*30d\s*\$0\.46/, {
    useInnerText: true,
  });

  await usage.click();
  const popover = page.locator("#usage-popover");
  await expect(popover).toContainText("Weekly soft cap");
  await expect(popover).toContainText("$0.46 of $500");
  await expect(popover).toContainText("Monthly soft cap");
  await expect(popover).toContainText("$0.46 of $2,000");
  await expect(popover.getByRole("link", { name: "Details" })).toHaveAttribute(
    "href",
    "/people/dev%40example.com",
  );
  await page.keyboard.press("Escape");

  // Tall windows move usage to the top bar, beside the avatar.
  await page.setViewportSize({ width: 1440, height: 1150 });
  await expect(sidebar).toHaveCount(0);
  await expect(usage).toContainText(/7d\s*\$0\.46\s*·\s*30d\s*\$0\.46/, {
    useInnerText: true,
  });
});

test("switches desktop navigation between adaptive, top bar, and sidebar", async ({
  page,
  dashboard,
}) => {
  // Adaptive tall windows use the top bar.
  await page.setViewportSize({ width: 1440, height: 1150 });
  await page.goto(dashboard.baseURL);
  const primary = page.getByRole("navigation", { name: "Primary" });
  const sidebar = page
    .locator('[data-slot="sidebar"]')
    .filter({ has: primary });
  await expect(primary).toBeVisible();
  await expect(sidebar).toHaveCount(0);

  const openMenu = async () => {
    await page
      .getByRole("button", { name: /^Open profile menu for Dashboard User/ })
      .click();
    return page.locator("#profile-popover");
  };
  const navigation = (await openMenu()).getByRole("group", {
    name: "Navigation",
  });
  await expect(
    navigation.getByRole("button", { name: "Adaptive navigation" }),
  ).toHaveAttribute("aria-pressed", "true");
  await navigation.getByRole("button", { name: "Sidebar navigation" }).click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  // The top bar's menu closes with the top bar.
  await expect(page.locator("#profile-popover")).toHaveCount(0);

  // The choice survives a reload, and the top bar choice ignores height.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(sidebar).toBeVisible();
  await (await openMenu())
    .getByRole("button", { name: "Top bar navigation" })
    .click();
  await expect(sidebar).toHaveCount(0);
  await expect(primary).toBeVisible();
  // The sidebar shortcut does nothing while the sidebar is hidden.
  await page.keyboard.press("ControlOrMeta+b");

  // Settings shows the same choice.
  await page.goto(`${dashboard.baseURL}/settings`);
  const setting = page.getByRole("radiogroup", { name: "Navigation" });
  await expect(setting.getByRole("radio", { name: /^Top bar/ })).toBeChecked();
  await setting.getByRole("radio", { name: /^Adaptive/ }).click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
});
