import { expect, test } from "./test";

test("collapses the app sidebar to a rail and keeps the choice", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${dashboard.baseURL}/system`);

  const sidebar = page.locator('[data-slot="sidebar"]').filter({
    has: page.getByRole("navigation", { name: "Primary" }),
  });
  const profile = sidebar.getByRole("button", {
    name: "Open profile menu for Dashboard User",
    exact: true,
  });
  const conversations = sidebar.getByRole("navigation", {
    name: "Your conversations",
  });
  // Every page shows the conversation list in the one sidebar.
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(conversations).toBeVisible();
  await expect(profile).toContainText("Dashboard User", {
    useInnerText: true,
  });

  // The rail keeps the destinations and the avatar, and the choice survives
  // a reload.
  await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(conversations).toBeHidden();
  await expect(profile).not.toContainText("Dashboard User", {
    useInnerText: true,
  });
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  // Narrower desktop windows keep the choice and the shortcut.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(conversations).toBeVisible();
});
