import type { Page } from "@playwright/test";

import { expect, test } from "./test";

// The Inbox count that the nav badge, the tab title and the tab icon share.
async function mockInboxCount(page: Page, count: { value: number }) {
  await page.route("**/api/review-items/count**", (route) =>
    route.fulfill({
      json: {
        codeChanges: 0,
        decisions: count.value,
        needsViewer: count.value,
        snoozed: 0,
      },
    }),
  );
}

// Record every title write. A pinned tab marks each one as an update.
async function recordTitles(page: Page) {
  await page.addInitScript(() => {
    const titles: string[] = [];
    Object.assign(window, { __titles: titles });
    const own = Object.getOwnPropertyDescriptor(Document.prototype, "title")!;
    Object.defineProperty(document, "title", {
      configurable: true,
      get: () => own.get!.call(document),
      set: (value: string) => {
        titles.push(value);
        own.set!.call(document, value);
      },
    });
  });
}

/** The titles written since the page loaded. */
function recordedTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as Window & { __titles: string[] }).__titles,
  );
}

test("the tab title and icon count the Inbox until it is zero", async ({
  dashboard,
  page,
}) => {
  const count = { value: 3 };
  await mockInboxCount(page, count);
  await page.goto(`${dashboard.baseURL}/inbox`);
  await expect(page).toHaveTitle("(3) Inbox - Junior");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

  count.value = 0;
  await page.reload();
  await expect(page).toHaveTitle("Inbox - Junior");
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
});

test("the tab icon count fills the top-left corner, clear of the eye", async ({
  dashboard,
  page,
}) => {
  await mockInboxCount(page, { value: 3 });
  await page.goto(`${dashboard.baseURL}/inbox`);
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);
  const href = (await icon.getAttribute("href"))!;
  // Which spots of the icon have the badge's accent fill.
  const accentSpots = await page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-dashboard-accent")
      .trim();
    context.fillRect(0, 0, 1, 1);
    const accent = [...context.getImageData(0, 0, 1, 1).data];
    context.drawImage(image, 0, 0);
    const size = image.width;
    const inset = Math.round(size * 0.16);
    const spots = {
      // The badge's fill right of the count, so the badge stays readable.
      badgeRight: [Math.round(size * 0.42), Math.round(size * 0.24)],
      bottomRight: [size - inset, size - inset],
      // Junior's eye.
      eye: [Math.round(size * 0.6), Math.round(size * 0.4)],
      // The badge's fill left of the count, clear of the glyph.
      topLeft: [Math.round(size * 0.05), Math.round(size * 0.19)],
      topRight: [size - inset, inset],
    };
    return Object.entries(spots)
      .filter(([, [x, y]]) => {
        const pixel = [...context.getImageData(x!, y!, 1, 1).data];
        return pixel.every((value, i) => Math.abs(value - accent[i]!) < 8);
      })
      .map(([name]) => name);
  }, href);
  expect(accentSpots).toEqual(["badgeRight", "topLeft"]);
});

test("turning off the tab count hides it in the title and on the icon", async ({
  dashboard,
  page,
}) => {
  await mockInboxCount(page, { value: 1 });
  await page.goto(`${dashboard.baseURL}/settings`);
  const icon = page.locator('link[rel="icon"]');
  const showCount = page.getByRole("checkbox", {
    name: "Show the Inbox count in the tab",
  });
  await expect(showCount).toBeChecked();
  await expect(page).toHaveTitle(/^\(1\) .+ - Junior$/);
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

  await showCount.click();
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
  await expect(page).toHaveTitle(/^[^(].* - Junior$/);

  // The choice stays on this browser.
  await page.reload();
  await expect(showCount).not.toBeChecked();
  await expect(page).toHaveTitle(/^[^(].* - Junior$/);
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
});

test("moving between pages never flashes the bare agent name in the tab", async ({
  dashboard,
  page,
}) => {
  await recordTitles(page);
  await mockInboxCount(page, { value: 1 });
  await page.goto(`${dashboard.baseURL}/inbox`);
  await expect(page).toHaveTitle("(1) Inbox - Junior");
  const primary = page.getByRole("navigation", { name: "Primary" });
  await primary.getByRole("link", { name: "Automations" }).click();
  await expect(page).toHaveTitle("(1) Automations - Junior");
  await page.goBack();
  await expect(page).toHaveTitle("(1) Inbox - Junior");

  const all = await recordedTitles(page);
  // From the first counted title on: the count loads after the page title.
  const titles = all.slice(all.indexOf("(1) Inbox - Junior"));
  expect(titles).toContain("(1) Automations - Junior");
  expect(titles.filter((title) => /^(\(\d+\) )?Junior$/.test(title))).toEqual(
    [],
  );
});
