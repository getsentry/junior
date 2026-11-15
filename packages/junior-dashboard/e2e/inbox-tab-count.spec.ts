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
  await page.goto(`${dashboard.baseURL}/review`);
  await expect(page).toHaveTitle("(3) Inbox - Junior");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

  count.value = 0;
  await page.reload();
  await expect(page).toHaveTitle("Inbox - Junior");
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
});

test("the tab icon count sits in the top-right corner", async ({
  dashboard,
  page,
}) => {
  await mockInboxCount(page, { value: 3 });
  await page.goto(`${dashboard.baseURL}/review`);
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);
  const href = (await icon.getAttribute("href"))!;
  // Which corners of the icon have the badge's accent fill.
  const accentCorners = await page.evaluate(async (src) => {
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
    const corners = {
      bottomRight: [size - inset, size - inset],
      topRight: [size - inset, inset],
    };
    return Object.entries(corners)
      .filter(([, [x, y]]) => {
        const pixel = [...context.getImageData(x!, y!, 1, 1).data];
        return pixel.every((value, i) => Math.abs(value - accent[i]!) < 8);
      })
      .map(([name]) => name);
  }, href);
  expect(accentCorners).toEqual(["topRight"]);
});

test("turning off the tab icon count keeps the title count", async ({
  dashboard,
  page,
}) => {
  await mockInboxCount(page, { value: 1 });
  await page.goto(`${dashboard.baseURL}/settings`);
  const icon = page.locator('link[rel="icon"]');
  const showCount = page.getByRole("checkbox", {
    name: "Show Inbox count on the tab icon",
  });
  await expect(showCount).toBeChecked();
  await expect(icon).toHaveAttribute("href", /^data:image\/png;base64,/);

  await showCount.click();
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
  await expect(page).toHaveTitle(/^\(1\) .+ - Junior$/);

  // The choice stays on this browser.
  await page.reload();
  await expect(showCount).not.toBeChecked();
  await expect(page).toHaveTitle(/^\(1\) .+ - Junior$/);
  await expect(icon).toHaveAttribute("href", "/favicon.ico");
});

test("moving between pages never flashes the bare agent name in the tab", async ({
  dashboard,
  page,
}) => {
  await recordTitles(page);
  await mockInboxCount(page, { value: 1 });
  await page.goto(`${dashboard.baseURL}/review`);
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
