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

// The page has this long to go still before a shot fails. Every wait in
// settle shares it.
const SETTLE_TIMEOUT_MS = 5_000;

// Frames in a row with no DOM change or scroll before the page counts as
// still. React commits, chart resizes, and scroll restores land within a
// frame or two of the change that causes them.
const QUIET_FRAMES = 3;

// Resizes to the page height before a shot fails. One resize fits most
// pages. A second fits a page that a tall viewport makes taller.
const MAX_FIT_RESIZES = 3;

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
    if (!options.clip) await fitPage(page, view.width);
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

/**
 * Make the viewport as tall as the page, so the capture fits it.
 *
 * For a page that does not fit, Playwright asks Chrome to capture beyond the
 * viewport. Chrome then resizes the page during the capture, sometimes to
 * 1x1, and the page's resize handlers run before it paints: charts measure
 * a few pixels, and a pinned transcript scrolls. The image shows that state.
 *
 * A taller viewport can make the page taller, such as the top bar that tall
 * windows show, so measure again until the page fits.
 */
async function fitPage(page: Page, width: number) {
  for (let resizes = 0; ; resizes += 1) {
    const height = await page.evaluate(pageHeight);
    if (height <= (page.viewportSize()?.height ?? 0)) return;
    if (resizes === MAX_FIT_RESIZES) {
      throw new Error(
        `The page kept growing with the viewport after ${MAX_FIT_RESIZES} resizes.`,
      );
    }
    await page.setViewportSize({ height, width });
    await settle(page);
  }
}

/** Page height as Playwright measures it for a full-page capture. */
function pageHeight() {
  const { body, documentElement: root } = document;
  return Math.max(
    body.scrollHeight,
    root.scrollHeight,
    body.offsetHeight,
    root.offsetHeight,
    body.clientHeight,
    root.clientHeight,
  );
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
 * A page that does not get there within a few seconds fails the test here,
 * not later as a Frameshift change on an unrelated pull request.
 */
async function settle(page: Page) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  const remaining = () => Math.max(deadline - Date.now(), 1);
  const pending = new Set<Request>();
  let started: Request[] = [];
  const onStart = (request: Request) => {
    pending.add(request);
    started.push(request);
  };
  const onEnd = (request: Request) => pending.delete(request);
  const urls = (requests: Iterable<Request>) =>
    [...requests].map((request) => request.url()).join(", ") || "unknown";
  page.on("request", onStart);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  try {
    // A commit can start a fetch, such as a list that loads when it first
    // shows. Wait again for what that fetch renders.
    do {
      if (started.length > 0 && Date.now() >= deadline) {
        throw new Error(
          `The page kept starting requests for ${SETTLE_TIMEOUT_MS}ms: ${urls(started)}`,
        );
      }
      started = [];
      await page
        .waitForLoadState("networkidle", { timeout: remaining() })
        .catch(() => {
          throw new Error(
            `Requests were still in flight after ${SETTLE_TIMEOUT_MS}ms: ${urls(pending)}`,
          );
        });
      await loadAssets(page, remaining());
      await waitForQuiet(page, remaining());
    } while (started.length > 0);
  } finally {
    page.off("request", onStart);
    page.off("requestfinished", onEnd);
    page.off("requestfailed", onEnd);
  }
}

async function loadAssets(page: Page, timeout: number) {
  const loaded = await page.evaluate(async (timeout) => {
    const assets = (async () => {
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
      // A video without its first frame is an empty box. With
      // preload="metadata" the browser may never load that frame, so ask
      // for the full load, as with the lazy images above.
      await Promise.allSettled(
        [...document.querySelectorAll("video")]
          .filter(
            (video) =>
              video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
              !video.error,
          )
          .map(
            (video) =>
              new Promise((resolve) => {
                video.preload = "auto";
                video.addEventListener("loadeddata", resolve, { once: true });
                video.addEventListener("error", resolve, { once: true });
              }),
          ),
      );
      return true;
    })();
    return Promise.race([
      assets,
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), timeout),
      ),
    ]);
  }, timeout);
  if (!loaded) {
    throw new Error(
      `Fonts, images, or videos were still loading after ${SETTLE_TIMEOUT_MS}ms.`,
    );
  }
}

/**
 * Wait for frames in a row with no DOM change and no scroll. Throws with the
 * element that kept changing, so the spec can wait for what moves it.
 */
async function waitForQuiet(page: Page, timeout: number) {
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
    { frames: QUIET_FRAMES, timeout },
  );
  if (busy) {
    throw new Error(
      `The page was still changing after ${SETTLE_TIMEOUT_MS}ms. Last change: ${busy}`,
    );
  }
}
