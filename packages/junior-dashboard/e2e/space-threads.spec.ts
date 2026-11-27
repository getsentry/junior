import type { Page } from "@playwright/test";
import type { ConversationChildAgent } from "@sentry/junior/api/schema";

import { NOW_MS } from "../src/mock-reporting/fixtures";
import { conversationMenuRow } from "./conversationMenu";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

const BILLING_ID = "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";
const BILLING = `/spaces/${BILLING_ID}`;

/**
 * Answer the Billing migration Lead's Threads with one or more in each
 * group. Row `index` moved last `index` hours before now. The mock Lead is
 * the only `local:web:` Conversation that the page reads Threads for.
 */
async function seedThreads(page: Page) {
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/conversations/local%3Aweb%3A") &&
      url.pathname.endsWith("/agents"),
    (route) => {
      const conversationId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/")[3]!,
      );
      const row = (
        index: number,
        title: string,
        fields: Partial<ConversationChildAgent>,
      ): ConversationChildAgent => ({
        archivedAt: null,
        conversationId: `internal:space-thread-${index}`,
        cumulativeDurationMs: (index + 1) * 60_000,
        kind: "thread",
        lastResult: "done",
        status: "idle",
        title,
        treeState: "done",
        updatedAt: new Date(NOW_MS - index * 3_600_000).toISOString(),
        watching: false,
        ...fields,
      });
      return route.fulfill({
        json: {
          agents: [
            row(0, "Close out the dry run", {}),
            // A Thread that the mock API can open.
            row(1, "Check refund webhooks", {
              conversationId: "internal:questions-qa",
              status: "running",
              treeState: "working",
            }),
            row(2, "Backfill invoice IDs", { watching: true }),
            row(3, "Approve the cutover window", { treeState: "needs_you" }),
            row(4, "Reconcile Stripe balances", { lastResult: "failed" }),
            row(5, "Migrate tax settings", {
              status: "running",
              treeState: "working",
            }),
            row(6, "Map plan IDs", {}),
          ],
          conversationId,
        },
      });
    },
  );
}

test("a Space's Threads list what each one needs, in attention order", async ({
  dashboard,
  page,
}) => {
  await page.clock.setFixedTime(NOW_MS);
  await seedThreads(page);
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const threads = page
    .getByRole("complementary", { name: "Conversation details" })
    .getByRole("region", { exact: true, name: "Threads" });

  // Needs you, then Working, then Waiting, then Done, with no group
  // headings. Each group runs newest first, and a failed Thread needs the
  // viewer.
  await expect(threads.getByRole("heading", { level: 4 })).toHaveCount(0);
  await expect(threads.getByRole("link")).toHaveText([
    /Approve the cutover window/,
    /Reconcile Stripe balances/,
    /Check refund webhooks/,
  ]);
  await screenshot(page, "space-threads", {
    lightTheme: true,
    view: "desktop",
  });
  await threads.getByRole("button", { name: "Show 4 more" }).click();
  await expect(threads.getByRole("link")).toHaveText([
    /Approve the cutover window/,
    /Reconcile Stripe balances/,
    /Check refund webhooks/,
    /Migrate tax settings/,
    /Backfill invoice IDs/,
    /Close out the dry run/,
    /Map plan IDs/,
  ]);

  // One click opens a Thread.
  await threads.getByRole("link", { name: /Check refund webhooks/ }).click();
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
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Conversation details").click();
  const threads = page
    .getByRole("dialog", { name: "Conversation details" })
    .getByRole("region", { exact: true, name: "Threads" });
  await expect(threads.getByRole("link").first()).toHaveText(
    /Approve the cutover window/,
  );
  await screenshot(page, "space-threads", { lightTheme: true, view: "mobile" });
});
