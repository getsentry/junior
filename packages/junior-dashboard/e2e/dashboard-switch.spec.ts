import { expect, test } from "./test";

test("Settings turns the new dashboard on and off", async ({
  dashboard,
  page,
  ui,
}) => {
  const isNew = ui === "inbox";
  await page.goto(`${dashboard.baseURL}/settings`);
  const toggle = page.getByRole("checkbox", { name: "Try the new dashboard" });
  // Only the current dashboard lets the user choose its navigation.
  const navigationChoice = page.getByRole("heading", {
    exact: true,
    name: "Navigation",
  });
  await expect(toggle).toBeChecked({ checked: isNew });
  await expect(navigationChoice).toBeVisible({ visible: !isNew });

  await toggle.click();

  // The page reloads into the other dashboard.
  await expect(toggle).toBeChecked({ checked: !isNew });
  await expect(navigationChoice).toBeVisible({ visible: isNew });
});
