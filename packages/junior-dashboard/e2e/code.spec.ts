import { expect, test } from "./test";

test("shows code activity", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/code`);

  await expect(
    page.getByRole("heading", { name: "Code", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Repositories and code changes created by Junior."),
  ).toBeVisible();
});
