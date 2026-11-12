import type { Page } from "@playwright/test";

import { mockReviewItems, rollout, rowHead } from "./inbox-fixture";
import { expect, test } from "./test";

const checkout = "Investigate checkout latency";

// One ask, so its row's Done takes the count to zero.
async function mockOneAsk(page: Page) {
  await mockReviewItems(page, { automations: () => 0, open: [rollout] });
}

function inboxTab(page: Page) {
  return page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /^Inbox/ });
}

async function closeCheckoutAsks(page: Page) {
  await rowHead(page, checkout).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

test("the tab title counts the Inbox, as its badge does", async ({
  dashboard,
  page,
}) => {
  await mockOneAsk(page);
  await page.goto(`${dashboard.baseURL}/`);
  await expect(inboxTab(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await expect(page).toHaveTitle("(1) Inbox - Junior");

  // Other pages keep their own title part after the count.
  await page.goto(`${dashboard.baseURL}/settings`);
  await expect(page).toHaveTitle("(1) Settings - Junior");

  await page.goto(`${dashboard.baseURL}/`);
  await closeCheckoutAsks(page);
  await expect(inboxTab(page)).toHaveAccessibleName("Inbox");
  await expect(page).toHaveTitle("Inbox - Junior");
});

test("the tab icon shows the Inbox count until it is zero", async ({
  dashboard,
  page,
}) => {
  await mockOneAsk(page);
  await page.goto(`${dashboard.baseURL}/`);
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

  await closeCheckoutAsks(page);
  await expect(page).toHaveTitle("Inbox - Junior");
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
});

test("turning off the tab icon count keeps the title count", async ({
  dashboard,
  page,
}) => {
  await mockOneAsk(page);
  await page.goto(`${dashboard.baseURL}/settings`);
  const icon = page.locator('link[rel="icon"]');
  const showCount = page.getByRole("checkbox", {
    name: "Show Inbox count on the tab icon",
  });
  await expect(showCount).toBeChecked();
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

  await showCount.click();
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
  await expect(page).toHaveTitle("(1) Settings - Junior");

  // The choice stays on this browser.
  await page.reload();
  await expect(showCount).not.toBeChecked();
  await expect(page).toHaveTitle("(1) Settings - Junior");
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
});
