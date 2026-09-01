import path from "node:path";
import type { Page } from "@playwright/test";

/** Desktop Frameshift viewport for dashboard journeys. */
export const DESKTOP = { height: 900, name: "desktop", width: 1440 } as const;

/** Mobile Frameshift viewport for dashboard journeys. */
export const MOBILE = { height: 844, name: "mobile", width: 390 } as const;

export type DashboardScreenshotViewport =
  | typeof DESKTOP
  | typeof MOBILE
  | { height: number; name: string; width: number };

const SCREENSHOT_DIR = path.resolve(".playwright/junior-dashboard/screenshots");

/**
 * Capture one loaded dashboard state for Frameshift.
 * Call after the journey has the page ready; filename is `{id}__{viewport}`.
 */
export async function captureDashboardScreenshot(
  page: Page,
  id: string,
  options: {
    clip?: {
      height: number;
      width: number;
      x: number;
      y: number;
    };
    /** When false, leave the page at the capture viewport. Default restores. */
    restoreViewport?: boolean;
    viewport?: DashboardScreenshotViewport;
  } = {},
) {
  const viewport = options.viewport ?? DESKTOP;
  const previous = page.viewportSize();
  await page.setViewportSize({
    height: viewport.height,
    width: viewport.width,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    animations: "disabled",
    clip: options.clip,
    fullPage: !options.clip,
    path: path.join(SCREENSHOT_DIR, `${id}__${viewport.name}.png`),
  });
  if (options.restoreViewport === false || !previous) return;
  await page.setViewportSize(previous);
}

/**
 * Capture the current loaded route at each viewport for Frameshift.
 * Prefer this after a smoke/journey assertion once content is visible.
 * Restores the page viewport afterward so later journey steps keep working.
 */
export async function captureDashboardScreenshots(
  page: Page,
  id: string,
  viewports: readonly DashboardScreenshotViewport[] = [DESKTOP, MOBILE],
) {
  const previous = page.viewportSize();
  for (const viewport of viewports) {
    await captureDashboardScreenshot(page, id, {
      restoreViewport: false,
      viewport,
    });
  }
  if (previous) await page.setViewportSize(previous);
}
