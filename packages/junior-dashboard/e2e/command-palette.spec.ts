import { expect, test } from "./test";

test("searches conversations from the command palette and opens one", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  const input = palette.getByRole("combobox");
  await expect(input).toBeFocused();
  await expect(palette.getByRole("group", { name: "Recent" })).toBeVisible();

  await input.fill("checkout");
  const results = palette.getByRole("group", { name: "Conversations" });
  await expect(
    results.getByRole("option", { name: /Checkout latency triage/ }),
  ).toBeVisible();
  await expect(
    results.getByRole("option", { name: /Investigate checkout latency/ }),
  ).toHaveAttribute("aria-selected", "true");

  await input.press("ArrowDown");
  await expect(
    results.getByRole("option", { name: /Checkout latency triage/ }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");

  await expect(palette).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("jumps to a page from the command palette", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.getByRole("combobox").fill("code");
  await palette
    .getByRole("group", { name: "Go to" })
    .getByRole("option", { name: "Code" })
    .click();

  await expect(page).toHaveURL(/\/code$/);
  await expect(palette).toHaveCount(0);
});
