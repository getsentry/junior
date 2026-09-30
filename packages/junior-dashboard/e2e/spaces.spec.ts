import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("browses nested Spaces like a forum", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/spaces`);
  await expect(
    page.getByRole("heading", { name: "Spaces", exact: true }),
  ).toBeVisible();
  await screenshot(page, "spaces");

  await page.getByRole("link", { name: /^SDKs/ }).click();
  await page.getByRole("link", { name: /^JavaScript/ }).click();
  await expect(
    page.getByRole("heading", { name: "JavaScript", exact: true }),
  ).toBeVisible();
  const path = page.getByRole("navigation", { name: "Space path" });
  await expect(path.getByRole("link", { name: "SDKs" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Cloudflare SDK release is blocked/ }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );
  await expect(
    page.getByText("1 private conversation is also in this Space."),
  ).toBeVisible();
  await screenshot(page, "spaces-detail");

  await path.getByRole("link", { name: "Spaces" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/spaces`);
});
