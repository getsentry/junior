import { NOW_MS } from "../../src/mock-reporting/fixtures";
import { mockLandingAutomationApis } from "../automation-landing-fixture";
import { mockReviewItems, rollout } from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("the action filter lists the viewer's snoozes, and Wake ends one", async ({
    page,
    dashboard,
  }) => {
    await mockLandingAutomationApis(page);
    await mockReviewItems(page, {
      open: [rollout],
      snoozes: [
        {
          conversationId: rollout.addedByConversationId,
          untilMs: NOW_MS + 86_400_000,
        },
      ],
    });
    await page.goto(`${dashboard.baseURL}/automations`);
    const show = page.getByRole("group", { name: "Show" });
    const snoozes = page.getByRole("region", { name: "Snoozes" });
    const automation = page.getByRole("link", { name: /^Open automation: / });
    // Runs is the default: the Automations that run, and no snoozes.
    await expect(automation.first()).toBeVisible();
    await expect(snoozes).toHaveCount(0);

    await show.getByRole("button", { name: "Snoozes", exact: true }).click();
    await expect(page).toHaveURL(/[?&]action=snoozes(?:&|$)/);
    await expect(snoozes).toContainText(rollout.title);
    await expect(automation).toHaveCount(0);
    await screenshot(page, "automations-snoozes", {
      lightTheme: true,
      view: "desktop",
    });

    await show.getByRole("button", { name: "All", exact: true }).click();
    await expect(snoozes).toContainText(rollout.title);
    await expect(automation.first()).toBeVisible();

    const woken = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname.endsWith("/api/automations/snooze-0"),
    );
    await snoozes.getByRole("button", { name: "Wake" }).click();
    await woken;
    await expect(snoozes).toHaveCount(0);
    await show.getByRole("button", { name: "Runs", exact: true }).click();
    await expect(page).not.toHaveURL(/[?&]action=/);
  });

  test("groups automations into To do, then by state, on the landing page", async ({
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
