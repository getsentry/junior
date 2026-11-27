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

test("a Space's Threads list in Work by state, finished ones last", async ({
  dashboard,
  page,
}) => {
  await page.clock.setFixedTime(NOW_MS);
  await seedThreads(page);
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const work = page
    .getByRole("complementary", { name: "Conversation details" })
    .getByRole("region", { exact: true, name: "Work" });

  // A wait on the viewer and a failure first, then running, then waiting.
  // Each state keeps the loaded order, newest first, and finished Threads
  // wait behind "Show finished".
  await expect(work.getByRole("link")).toHaveText([
    /Approve the cutover window/,
    /Reconcile Stripe balances/,
    /Check refund webhooks/,
    /Migrate tax settings/,
    /Backfill invoice IDs/,
  ]);
  await screenshot(page, "space-threads", {
    lightTheme: true,
    view: "desktop",
  });
  await work.getByRole("button", { name: "Show finished" }).click();
  await expect(work.getByRole("link")).toHaveText([
    /Approve the cutover window/,
    /Reconcile Stripe balances/,
    /Check refund webhooks/,
    /Migrate tax settings/,
    /Backfill invoice IDs/,
    /Close out the dry run/,
    /Map plan IDs/,
  ]);

  // One click opens a Thread.
  await work.getByRole("link", { name: /Check refund webhooks/ }).click();
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
  const work = page
    .getByRole("dialog", { name: "Conversation details" })
    .getByRole("region", { exact: true, name: "Work" });
  await expect(work.getByRole("link").first()).toHaveText(
    /Approve the cutover window/,
  );
  await screenshot(page, "space-threads", { lightTheme: true, view: "mobile" });
});
