import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

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

// The full-screen noise texture rasterizes slightly differently on each run.
// Hide it so visual review only reports real changes.
const SCREENSHOT_STYLE = [
  "[data-dashboard-noise] { display: none !important; }",
  // Native video controls are browser UI. Their loading spinner fades out on
  // its own clock after the video loads, so each run caught it at another
  // angle.
  "video::-webkit-media-controls { display: none !important; }",
].join("\n");

// Each worker's dashboard server listens on a random port. Pages that show
// the dashboard URL, such as the MCP settings, show this origin instead.
const SCREENSHOT_ORIGIN = "http://127.0.0.1:3000";

type ScreenshotOptions = {
  clip?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  /** Also save `{name}-light__{view}.png` in the light theme. */
  lightTheme?: boolean;
  target?: Locator;
  view?: View;
};

/**
 * Save a loaded page image for visual review.
 * Writes `{name}__desktop.png` and `{name}__mobile.png` by default.
 * Pass `view` to save only one size. Pass `target` to save only one element.
 * Pass `lightTheme` to also save light theme copies.
 */
export async function screenshot(
  page: Page,
  name: string,
  options: ScreenshotOptions = {},
) {
  await capture(page, name, options);
  if (!options.lightTheme) return;

  // The theme script follows the system color scheme while no choice is saved.
  const root = page.locator("html");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await capture(page, `${name}-light`, options);
  // Restore the dark default from playwright.config.ts.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
}

async function capture(page: Page, name: string, options: ScreenshotOptions) {
  const previous = page.viewportSize();
  const views = options.view ? [VIEWS[options.view]] : [desktop, mobile];

  for (const view of views) {
    const size = page.viewportSize();
    if (size?.width !== view.width || size.height !== view.height) {
      // A resize moves the page under the pointer, so whichever element
      // lands there shows its hover state or tooltip. Park the pointer.
      await page.mouse.move(0, 0);
    }
    await page.setViewportSize({
      height: view.height,
      width: view.width,
    });
    await settle(page);
    // For a page taller than the viewport, Chrome resizes the view during the
    // capture. It paints that size before ResizeObserver callbacks and React
    // updates run, so charts and sticky bars keep the old size in the image.
    // Resize first and let the page settle, so the capture fits the viewport.
    const height = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    if (!options.clip && height > view.height) {
      await page.setViewportSize({ height, width: view.width });
      await settle(page);
    }
    // Element shots clip a full-page capture. A plain element shot scrolls
    // the element into view, where sticky page chrome can cover it.
    const clip = options.target
      ? await options.target.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            height: Math.round(box.height),
            width: Math.round(box.width),
            x: Math.round(box.x + window.scrollX),
            y: Math.round(box.y + window.scrollY),
          };
        })
      : options.clip;
    const restoreOrigin = await page.evaluateHandle((origin) => {
      const changed: Array<[Text, string]> = [];
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue ?? "";
        if (!text.includes(location.origin)) continue;
        changed.push([node as Text, text]);
        node.nodeValue = text.replaceAll(location.origin, origin);
      }
      return () => {
        for (const [node, text] of changed) node.nodeValue = text;
      };
    }, SCREENSHOT_ORIGIN);
    await page.screenshot({
      animations: "disabled",
      clip,
      fullPage: !options.clip,
      style: SCREENSHOT_STYLE,
      path: path.join(SCREENSHOT_DIR, `${name}__${view.name}.png`),
    });
    // Later steps of the spec read the real URL.
    await restoreOrigin.evaluate((restore) => restore());
  }

  if (previous) await page.setViewportSize(previous);
}

/**
 * Wait for network, fonts, images, first video frames, and two frames so the
 * page stops moving.
 */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    // fonts.ready only waits for faces the page has already requested. A
    // late web font swap changes text width and layout, so load every face.
    await Promise.allSettled([...document.fonts].map((font) => font.load()));
    await document.fonts.ready;
    // Full-page captures include offscreen images. Start lazy loads before
    // decoding, and let failed images render their fallback in the capture.
    await Promise.allSettled(
      [...document.images].map((image) => {
        image.loading = "eager";
        return image.decode();
      }),
    );
    // A video without its first frame is an empty box. Stop waiting after
    // a few seconds, as the browser may load only the metadata.
    await Promise.race([
      Promise.allSettled(
        [...document.querySelectorAll("video")]
          .filter(
            (video) =>
              video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
              !video.error,
          )
          .map(
            (video) =>
              new Promise((resolve) => {
                video.addEventListener("loadeddata", resolve, { once: true });
                video.addEventListener("error", resolve, { once: true });
              }),
          ),
      ),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}
