import path from "node:path";
import type { Page } from "@playwright/test";

/** Default desktop browser size for route shots. */
export const desktop = { height: 900, name: "desktop", width: 1440 } as const;

/** Default mobile browser size for route shots. */
export const mobile = { height: 844, name: "mobile", width: 390 } as const;

type View = "desktop" | "mobile";

type ViewSize = {
  height: number;
  name: string;
  width: number;
};

const VIEWS: Record<View, ViewSize> = {
  desktop,
  mobile,
};

const SCREENSHOT_DIR = path.resolve(".playwright/junior-dashboard/screenshots");

/**
 * Save a loaded page image for visual review.
 * Writes `{name}__desktop.png` and `{name}__mobile.png` by default.
 * Pass `view` to save only one size.
 */
export async function screenshot(
  page: Page,
  name: string,
  options: {
    clip?: {
      height: number;
      width: number;
      x: number;
      y: number;
    };
    view?: View;
  } = {},
) {
  const previous = page.viewportSize();
  const views = options.view ? [VIEWS[options.view]] : [desktop, mobile];

  for (const view of views) {
    await page.setViewportSize({
      height: view.height,
      width: view.width,
    });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      animations: "disabled",
      clip: options.clip,
      fullPage: !options.clip,
      path: path.join(SCREENSHOT_DIR, `${name}__${view.name}.png`),
    });
  }

  if (previous) await page.setViewportSize(previous);
}
