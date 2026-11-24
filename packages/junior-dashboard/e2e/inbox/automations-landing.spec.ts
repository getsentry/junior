import { mockLandingAutomationApis } from "../automation-landing-fixture";
import { desktop, screenshot } from "../screenshot";
import { expect, test } from "../test";

test.describe("new UI", () => {
  test("groups automations into To do, then by latest run, on the landing page", async ({
    page,
    dashboard,
  }) => {
    await mockLandingAutomationApis(page);
    await page.goto(`${dashboard.baseURL}/automations`);
    await expect(
      page.getByRole("link", { name: /^Open automation: / }).first(),
    ).toBeVisible();
    await screenshot(page, "automations-landing", { lightTheme: true });

    // Filters open in a column beside the list, and every option is visible.
    await page.getByRole("button", { name: /^Filters/ }).click();
    const filters = page.getByRole("complementary", { name: "Filters" });
    await filters
      .getByRole("group", { name: "Filter by type" })
      .getByRole("button", { name: "Event", exact: true })
      .click();
    await expect(page).toHaveURL(/[?&]type=event(?:&|$)/);
    await expect(
      page.getByRole("link", { name: "Open automation: CVE sweep" }),
    ).toHaveCount(0);
    await screenshot(page, "automations-filters");
    await filters
      .getByRole("button", { name: "Clear all", exact: true })
      .click();
    await expect(page).not.toHaveURL(/[?&]type=/);

    // A long instruction stays in the main column, clamped until expanded.
    await page.goto(`${dashboard.baseURL}/automations/post-merge-cleanup`);
    await expect(
      page.getByRole("button", { name: "Expand instruction", exact: true }),
    ).toBeVisible();
    // The screenshot uses this size. A resize would move the pointer off the
    // chart and close its tooltip.
    await page.setViewportSize(desktop);
    await page
      .getByRole("region", { name: "Recent runs" })
      .getByRole("img")
      .getByRole("link")
      .last()
      .hover();
    await expect(page.getByRole("tooltip")).toContainText("Duration");
    await screenshot(page, "automation-details-long-instruction", {
      view: "desktop",
    });

    await page.goto(`${dashboard.baseURL}/automations/cve-sweep`);
    await expect(
      page.getByRole("heading", { name: "CVE sweep", exact: true }),
    ).toBeVisible();
    await screenshot(page, "automation-details-failing", { lightTheme: true });

    await page.goto(`${dashboard.baseURL}/automations/streaming-oncall`);
    await expect(
      page.getByRole("heading", {
        name: "Streaming on-call check",
        exact: true,
      }),
    ).toBeVisible();
    await screenshot(page, "automation-details-healthy");
  });
});
