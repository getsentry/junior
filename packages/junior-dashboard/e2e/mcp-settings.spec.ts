import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("shows MCP client config from the settings navigation", async ({
  page,
  dashboard,
}) => {
  await page.goto(`${dashboard.baseURL}/settings`);
  await page.getByRole("link", { name: "MCP", exact: true }).click();

  await expect(page).toHaveURL(/\/settings\/mcp$/);
  await expect(page.getByRole("heading", { name: "MCP" })).toBeVisible();
  const url = new URL("/api/mcp", dashboard.baseURL).toString();
  await expect(page.getByText(url, { exact: true })).toBeVisible();
  await expect(
    page.getByText(`claude mcp add --transport http junior ${url}`),
  ).toBeVisible();
  await screenshot(page, "settings-mcp", { view: "desktop" });
});
