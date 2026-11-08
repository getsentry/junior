import { expect, test } from "./test";

test("switches conversations from the command palette without a server search", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  // Rows must not wait on the server search.
  await page.route(/\/api\/conversations\?q=/, (route) => route.abort());
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const input = palette.getByRole("combobox");
  await expect(input).toBeFocused();
  await expect(palette.getByRole("group", { name: "Recent" })).toBeVisible();

  // Scattered letters match.
  await input.fill("chk tri");
  const results = palette.getByRole("group", { name: "Conversations" });
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(
    results.getByRole("option", { name: /Checkout latency triage/ }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");

  await expect(palette).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();

  // The open conversation is not a row, so Enter switches away from it.
  await page.getByRole("button", { name: "Go to conversation" }).click();
  await expect(input).toBeFocused();
  await expect(
    palette.getByRole("option", { name: /Checkout latency triage/ }),
  ).toHaveCount(0);
  // A typo still matches.
  await input.fill("chekcout");
  await expect(
    palette.getByRole("option", { name: /Investigate checkout latency/ }),
  ).toHaveAttribute("aria-selected", "true");
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
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const input = palette.getByRole("combobox");
  await expect(palette.getByRole("group", { name: "Recent" })).toBeVisible();
  // The highlighted recent conversation still matches "co" loosely, but the
  // page whose name starts with it ranks first and takes Enter.
  await input.fill("co");
  await input.press("Enter");

  await expect(page).toHaveURL(/\/code$/);
  await expect(palette).toHaveCount(0);
});
