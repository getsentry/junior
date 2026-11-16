import type { Page } from "@playwright/test";

import { viewAsParticipant } from "./conversationMenu";
import { mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

// Home card gestures on a touch screen: a long press opens the row sheet,
// and a sideways swipe runs a row action.
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("opens the row sheet on a long press of a home card", async ({
    page,
    dashboard,
  }) => {
    await viewAsParticipant(page);
    await page.setViewportSize(mobile);
    await page.goto(dashboard.baseURL);

    const card = page.getByRole("link", { name: "Open Closed issue summary" });
    await expect(card).toBeVisible();
    // Playwright has no long press. Hold a touch past the menu delay.
    await card.dispatchEvent("touchstart", {
      touches: [{ clientX: 1, clientY: 1, identifier: 1 }],
    });
    // A touch opens the rows as a sheet, not as a menu at the finger.
    const sheet = page.getByRole("dialog", { name: "Closed issue summary" });
    await expect(sheet).toBeVisible();
    // A mobile browser can send its own contextmenu from the same press.
    // The open sheet hides the card from role queries.
    await page
      .locator('a[aria-label="Open Closed issue summary"]')
      .dispatchEvent("contextmenu");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await screenshot(page, "conversation-home-card-sheet", { view: "mobile" });

    await sheet.getByRole("button", { name: "Pin", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page
        .locator("section:has(#conversation-section-pinned)")
        .getByRole("link", { name: "Open Closed issue summary" }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  });

  test("moves a pinned home card from its row sheet", async ({
    page,
    dashboard,
  }) => {
    await viewAsParticipant(page);
    await page.setViewportSize(mobile);
    await page.goto(dashboard.baseURL);

    const pinned = page.locator(
      'section[aria-labelledby="conversation-section-pinned"] a[aria-label]',
    );
    await swipeCard(page, "Open Closed issue summary", 160);
    await expect(pinned).toHaveCount(1);
    await swipeCard(page, "Open Sandbox validation", 160);
    await expect(pinned).toHaveCount(2);
    const order = await pinned.evaluateAll((links) =>
      links.map((link) => link.getAttribute("aria-label")),
    );

    // A long press on a pinned card opens the sheet, not a pin drag.
    await pinned.first().dispatchEvent("touchstart", {
      touches: [{ clientX: 1, clientY: 1, identifier: 1 }],
    });
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Move up" })).toBeDisabled();
    await sheet.getByRole("button", { name: "Move down" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(pinned.first()).toHaveAttribute("aria-label", order[1]!, {
      timeout: 5_000,
    });
  });

  test("pins and archives a home card with a swipe", async ({
    page,
    dashboard,
  }) => {
    await viewAsParticipant(page);
    await page.setViewportSize(mobile);
    await page.goto(dashboard.baseURL);

    const name = "Open Closed issue summary";
    const swipe = (dx: number) => swipeCard(page, name, dx);
    const pinned = page
      .locator("section:has(#conversation-section-pinned)")
      .getByRole("link", { name });

    await expect(page.getByRole("link", { name })).toBeVisible();
    // A swipe right pins.
    await swipe(160);
    await expect(pinned).toBeVisible();
    // A swipe left archives, and the lift does not open the card.
    await swipe(-160);
    await expect(page.getByText("Conversation archived")).toBeVisible();
    await expect(page.getByRole("link", { name })).toHaveCount(0);
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  });
});

/** Swipe a home card sideways. Playwright has no swipe. */
async function swipeCard(page: Page, name: string, dx: number) {
  const card = page.getByRole("link", { name });
  await card.dispatchEvent("touchstart", {
    touches: [{ clientX: 200, clientY: 1, identifier: 1 }],
  });
  await card.dispatchEvent("touchmove", {
    touches: [{ clientX: 200 + dx, clientY: 1, identifier: 1 }],
  });
  await card.dispatchEvent("touchend", { touches: [] });
}
