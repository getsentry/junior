import type { Page } from "@playwright/test";
import type { ConversationSummaryReport } from "@sentry/junior/api/schema";

import { NOW_MS } from "../src/mock-reporting/fixtures";
import { mockFeedPage } from "./mock-reports";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

const BILLING_ID = "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";
const BILLING = `/spaces/${BILLING_ID}`;

/**
 * Answer the Billing migration Space's Threads with one or more in each
 * group. Row `index` had its last Message `index` hours before now.
 */
async function seedThreads(page: Page) {
  await page.route(
    (url) =>
      url.pathname === "/api/conversations" &&
      url.searchParams.get("spaceId") === BILLING_ID,
    async (route) => {
      const feed = await mockFeedPage(route);
      const base = feed.conversations[0]!;
      const row = (
        index: number,
        displayTitle: string,
        summary: string,
        fields: Partial<ConversationSummaryReport>,
      ) => {
        const at = new Date(NOW_MS - index * 3_600_000).toISOString();
        return {
          ...base,
          activityPreview: undefined,
          conversationId: `internal:space-thread-${index}`,
          displayTitle,
          lastMessageAt: at,
          lastSeenAt: at,
          latestTurnFailed: false,
          pinnedAt: null,
          status: "done" as const,
          summary,
          threads: undefined,
          treeState: "done" as const,
          turnActive: false,
          watching: false,
          ...fields,
        };
      };
      return route.fulfill({
        json: {
          ...feed,
          conversations: [
            row(
              0,
              "Close out the dry run",
              "Dry run matched every invoice.",
              {},
            ),
            // A Thread that the mock API can open.
            row(1, "Check refund webhooks", "Replaying last week's refunds.", {
              conversationId: "internal:questions-qa",
              status: "working",
              treeState: "working",
              turnActive: true,
            }),
            row(2, "Backfill invoice IDs", "Waits for the nightly export.", {
              watching: true,
            }),
            row(
              3,
              "Approve the cutover window",
              "Pick a window before Friday.",
              { status: "needs_input", treeState: "needs_you" },
            ),
            row(4, "Reconcile Stripe balances", "Lost access to the API.", {
              latestTurnFailed: true,
            }),
            row(5, "Migrate tax settings", "Copying region rules.", {
              status: "working",
              treeState: "working",
              turnActive: true,
            }),
            row(6, "Map plan IDs", "Every plan has a new ID.", {}),
          ],
          nextCursor: undefined,
        },
      });
    },
  );
}

test("a Space's Threads show what each one needs, Done collapsed", async ({
  dashboard,
  page,
}) => {
  await page.clock.setFixedTime(NOW_MS);
  await seedThreads(page);
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const threads = page
    .getByRole("complementary", { name: "Space details" })
    .getByRole("region", { exact: true, name: "Threads" });
  const group = (name: string) =>
    threads.getByRole("region", { exact: true, name });

  // Needs you, then Working, then Waiting, then Done. Each group runs
  // newest Message first, and a failed Turn needs the viewer.
  await expect(threads.getByRole("heading", { level: 4 })).toHaveText([
    "Needs you · 2",
    "Working · 2",
    "Waiting · 1",
    "Done · 2",
  ]);
  await expect(group("Needs you").getByRole("link")).toHaveText([
    /Approve the cutover window/,
    /Reconcile Stripe balances/,
  ]);
  await expect(
    group("Needs you").getByRole("img", { name: "Failed" }),
  ).toBeVisible();
  await expect(group("Working").getByRole("link")).toHaveText([
    /Check refund webhooks/,
    /Migrate tax settings/,
  ]);
  await expect(group("Waiting").getByRole("link")).toHaveText([
    /Backfill invoice IDs/,
  ]);
  // Each row shows its summary under its title.
  await expect(
    group("Waiting").getByText("Waits for the nightly export."),
  ).toBeVisible();

  // Done starts collapsed, and its heading opens it.
  const done = group("Done");
  await expect(done.getByRole("link")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await screenshot(page, "space-threads", {
    lightTheme: true,
    view: "desktop",
  });
  await done.getByRole("button", { name: "Done · 2" }).click();
  await expect(done.getByRole("link")).toHaveText([
    /Close out the dry run/,
    /Map plan IDs/,
  ]);

  // One click opens a Thread.
  await group("Working")
    .getByRole("link", { name: /Check refund webhooks/ })
    .click();
  await expect(page).toHaveURL(/\/conversations\/internal%3Aquestions-qa$/);
  await expect(
    page.getByRole("heading", { name: "Plan the billing migration" }),
  ).toBeVisible();
});

test("a phone shows a Space's Threads in its details sheet", async ({
  dashboard,
  page,
}) => {
  await page.clock.setFixedTime(NOW_MS);
  await seedThreads(page);
  await page.setViewportSize(mobile);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  await page.getByRole("button", { name: "Space details" }).click();
  const threads = page
    .getByRole("dialog", { name: "Space details" })
    .getByRole("region", { exact: true, name: "Threads" });
  await expect(threads.getByRole("heading", { level: 4 })).toHaveText([
    "Needs you · 2",
    "Working · 2",
    "Waiting · 1",
    "Done · 2",
  ]);
  await screenshot(page, "space-threads", { lightTheme: true, view: "mobile" });
});
