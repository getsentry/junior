import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

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

// Settle passes to try for one in which the page starts no request.
const MAX_SETTLE_PASSES = 5;

// Frames in a row with no DOM change or scroll before the page counts as
// still. React commits, chart resizes, and scroll restores land within a
// frame or two of the change that causes them.
const QUIET_FRAMES = 3;

// A page that keeps changing for this long fails the shot.
const QUIET_TIMEOUT_MS = 10_000;

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
      // lands there shows its hover state or tooltip. Move the pointer off
      // the page, which sends mouseleave. A spec that shoots a hover state
      // sets this size first, so its pointer stays.
      await page.mouse.move(-1, -1);
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
    const file = `${name}__${view.name}.png`;
    // Element shots clip a full-page capture. A plain element shot scrolls
    // the element into view, where sticky page chrome can cover it.
    const image = await page.screenshot({
      animations: "disabled",
      clip: options.target ? await boxOf(options.target) : options.clip,
      fullPage: !options.clip,
      style: SCREENSHOT_STYLE,
    });
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await writeFile(path.join(SCREENSHOT_DIR, file), image);
    // Later steps of the spec read the real URL.
    await restoreOrigin.evaluate((restore) => restore());
  }

  if (previous) await page.setViewportSize(previous);
}

/** Page box of an element, in whole pixels. */
async function boxOf(target: Locator) {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      height: Math.round(box.height),
      width: Math.round(box.width),
      x: Math.round(box.x + window.scrollX),
      y: Math.round(box.y + window.scrollY),
    };
  });
}

/**
 * Wait until the page is done: no request in flight, every font, image, and
 * first video frame loaded, and no DOM change or scroll for a few frames.
 * A page that does not get there fails the test here, not later as a
 * Frameshift change on an unrelated pull request.
 */
async function settle(page: Page) {
  for (let pass = 1; pass <= MAX_SETTLE_PASSES; pass += 1) {
    const started: string[] = [];
    const onRequest = (request: Request) => started.push(request.url());
    page.on("request", onRequest);
    try {
      await page.waitForLoadState("networkidle");
      await loadAssets(page);
      await waitForQuiet(page);
    } finally {
      page.off("request", onRequest);
    }
    // A commit can start a fetch, such as a list that loads when it first
    // shows. Wait again for what that fetch renders.
    if (started.length === 0) return;
    if (pass === MAX_SETTLE_PASSES) {
      throw new Error(
        `The page kept starting requests before the shot: ${started.join(", ")}`,
      );
    }
  }
}

async function loadAssets(page: Page) {
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
  });
}

/**
 * Wait for frames in a row with no DOM change and no scroll. Throws with the
 * element that kept changing, so the spec can wait for what moves it.
 */
async function waitForQuiet(page: Page) {
  const busy = await page.evaluate(
    ({ frames, timeout }) =>
      new Promise<string | null>((resolve) => {
        let last = "";
        let quiet = 0;
        const changed = (target: EventTarget | null) => {
          quiet = 0;
          if (!(target instanceof Element)) return;
          last = target.id
            ? `#${target.id}`
            : `${target.tagName.toLowerCase()}.${[...target.classList].slice(0, 3).join(".")}`;
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) changed(record.target);
        });
        observer.observe(document.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        const onScroll = (event: Event) => changed(event.target);
        document.addEventListener("scroll", onScroll, true);
        const done = (result: string | null) => {
          observer.disconnect();
          document.removeEventListener("scroll", onScroll, true);
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => done(last || "document"), timeout);
        const frame = () => {
          quiet += 1;
          if (quiet > frames) done(null);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    { frames: QUIET_FRAMES, timeout: QUIET_TIMEOUT_MS },
  );
  if (busy) {
    throw new Error(
      `The page kept changing for ${QUIET_TIMEOUT_MS}ms before the shot. Last change: ${busy}`,
    );
  }
}
