import { startDashboardE2eServer } from "./harness";
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
    navigation.getByRole("menuitemradio", { name: "Adaptive navigation" }),
  ).toHaveAttribute("aria-checked", "true");
  await navigation
    .getByRole("menuitemradio", { name: "Sidebar navigation" })
    .click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  // The top bar's menu closes with the top bar.
  await expect(page.locator("#profile-popover")).toHaveCount(0);

  // The choice survives a reload, and the top bar choice ignores height.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(sidebar).toBeVisible();
  await (await openMenu())
    .getByRole("menuitemradio", { name: "Top bar navigation" })
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
