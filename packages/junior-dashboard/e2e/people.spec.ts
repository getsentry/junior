import { expect, test } from "./test";

test("explores people activity", async ({ page, dashboard }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(`${dashboard.baseURL}/system/people`);

  await expect(
    page.getByRole("heading", { name: "People", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Active people per day" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "7d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("combobox", { name: "Sort people" })).toHaveValue(
    "spend",
  );
  await expect(page.getByText("Model spend", { exact: true })).toBeVisible();
  await expect(page.getByText("Highest spend", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Biggest increase", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("System navigation").getByRole("link", { name: "People" }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "24h" }).click();
  await expect(page.getByRole("button", { name: "24h" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("img", { name: "Active people per hour" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "90d" }).click();
  await expect(page.getByRole("button", { name: "90d" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("img", { name: "Active people per day" }),
  ).toBeVisible();
});
