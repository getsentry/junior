import type { Page } from "@playwright/test";
import { waitForOutlineRead } from "../harness";
import { expect, test } from "../test";

test.describe("new UI", () => {
  // Link, file, and linked-work cards in comfortable Inbox rows.

  const checkout = "Investigate checkout latency";

  test("comfortable rows show cards for message links that name an object", async ({
    dashboard,
    page,
  }) => {
    const person = `${dashboard.baseURL}/people/dev%40example.com`;
    const unknown = "https://example.com/no-card";
    // The feed lists the links from this row's messages.
    await page.route(
      (url) => url.pathname === "/api/conversations",
      async (route) => {
        const response = await route.fetch();
        const feed = (await response.json()) as {
          conversations: Array<{ displayTitle: string; links?: string[] }>;
        };
        for (const row of feed.conversations) {
          if (row.displayTitle === "Investigate checkout latency") {
            row.links = [person, unknown];
          }
        }
        await route.fulfill({ json: feed, response });
      },
    );
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    await page.evaluate(() => {
      localStorage.setItem("junior:density", "comfortable");
    });
    await page.reload();
    const row = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Investigate checkout latency" })
      .first();
    const links = row.getByRole("group", { name: "Links" });
    // The person link resolves to a card; the other link names nothing and
    // shows nothing, not a bare link.
    await expect(links.getByRole("link")).toHaveCount(1);
    await expect(links.getByRole("link")).toHaveAttribute("href", person);
    // Its label repeats its title, so the card names it once.
    await expect(links.getByRole("link")).toHaveText("Morgan Lee");
    await expect(links.getByRole("link")).toHaveAttribute(
      "title",
      "Morgan Lee",
    );
    await expect(row.locator(`a[href="${unknown}"]`)).toHaveCount(0);
  });

  test("comfortable rows show files and linked work as cards, and compact rows keep chips", async ({
    dashboard,
    page,
  }) => {
    const density = async (value: "comfortable" | "compact") => {
      await page.evaluate((next) => {
        localStorage.setItem("junior:density", next);
      }, value);
      await page.reload();
    };
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    await density("comfortable");
    const release = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Package release and self-update" })
      .first();
    const work = release.getByRole("group", { name: "Linked work" });
    // One line each: the status icon, the title, and the repo and number,
    // since relay is not the row's main repo. The changes that its pill
    // (#2201) and its image card (#91) name show only there.
    await expect(work.getByRole("link")).toHaveText([
      "Return 429 before parsing oversized envelopesrelay#44",
    ]);
    const cards = work.locator("[data-linked-work-card]");
    await expect(cards.getByRole("img", { name: /: merged$/ })).toBeVisible();
    await expect
      .poll(() =>
        cards
          .locator("[data-status-tone]")
          .evaluateAll((lines) =>
            lines.map((line) => line.getAttribute("data-status-tone")),
          ),
      )
      .toEqual(["accent"]);
    await expect(
      work.getByRole("link", { name: /Return 429/ }),
    ).toHaveAttribute("href", "https://github.com/getsentry/relay/pull/44");
    // Work saved without a title follows as one quiet line, with no link.
    const qa = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Dashboard QA edge cases" })
      .first();
    await expect(qa.getByRole("group", { name: "Linked work" })).toBeAttached();
    await expect(qa.getByRole("link", { name: /getsentry/ })).toHaveCount(0);
    await expect(qa.locator("[data-linked-work-chip]").first()).toBeAttached();
    // Its newest files: images in the strip, loaded lazily, and other
    // files by name.
    const images = qa.getByRole("group", { name: "Images" });
    await images.scrollIntoViewIfNeeded();
    for (const name of ["chart.png", "chart-detail.png"]) {
      const thumbnail = images.getByRole("img", { name, exact: true });
      await expect(thumbnail).toHaveAttribute("loading", "lazy");
      await expect(thumbnail).toHaveAttribute(
        "src",
        /\/attachments\/qa-chart-png$/,
      );
    }
    await expect(
      qa.getByRole("group", { name: "Files" }).getByRole("link"),
    ).toHaveText(["demo.mp4"]);
    // A pull request card shows the first image of its description.
    const preview = page
      .locator("[data-inbox-row]")
      .filter({ hasText: "Investigate checkout latency" })
      .first()
      .getByRole("img", {
        name: "Preview of Retry checkout writes after lock timeouts",
      });
    // The mock serves the preview itself.
    await expect(preview).toHaveAttribute(
      "src",
      /\/api\/images\/checkout-p95$/,
    );
    await preview.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        preview.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);

    await density("compact");
    await expect(qa.getByRole("group", { name: "Files" })).toHaveCount(0);
    await expect(qa.getByRole("group", { name: "Images" })).toHaveCount(0);
    // Compact rows name each piece of work by its number, in its status
    // color, on one line. Its title is its name and its tooltip.
    await expect(release.locator("[data-linked-work-card]")).toHaveCount(0);
    const chips = release.locator("[data-linked-work-chip]");
    await expect(chips.first()).toHaveAccessibleName(
      "Return 429 before parsing oversized envelopes #44",
    );
    await expect(chips.first().locator("[data-status-tone]")).toHaveAttribute(
      "data-status-tone",
      "accent",
    );
  });

  test("a linked-work preview that fails to load leaves no empty box", async ({
    dashboard,
    page,
  }) => {
    await page.route("**/api/images/checkout-p95", (route) =>
      route.fulfill({ status: 404 }),
    );
    const failed = page.waitForResponse("**/api/images/checkout-p95");
    await page.addInitScript(() =>
      localStorage.setItem("junior:density", "comfortable"),
    );
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const card = page
      .locator("[data-inbox-row]")
      .filter({ hasText: checkout })
      .first()
      .locator('[data-image-tile="work"]')
      .filter({ hasText: "Retry checkout writes after lock timeouts" });
    await card.scrollIntoViewIfNeeded();
    await failed;
    // Its line stays; the image and its box go.
    await expect(card.locator("[data-linked-work-card]")).toBeVisible();
    await expect(card.locator("img")).toHaveCount(0);
  });

  // The QA row has two images, so its strip ends in empty space.
  async function openQaStrip(page: Page, baseURL: string) {
    await page.addInitScript(() =>
      localStorage.setItem("junior:density", "comfortable"),
    );
    await page.goto(`${baseURL}/inbox?view=conversations`);
    const row = page
      .locator("li[data-inbox-row]")
      .filter({ hasText: "Dashboard QA edge cases" })
      .first();
    const strip = row.getByRole("group", { name: "Images" });
    await strip.scrollIntoViewIfNeeded();
    return { row, strip };
  }

  test("an image opens in the viewer, not in a new tab", async ({
    context,
    dashboard,
    page,
  }) => {
    const { strip } = await openQaStrip(page, dashboard.baseURL);
    const opened: string[] = [];
    context.on("page", (tab) => opened.push(tab.url()));
    const url = page.url();
    const image = strip.getByRole("link", { name: "chart.png", exact: true });
    await image.click();
    const viewer = page.getByRole("dialog", { name: "chart.png" });
    await expect(viewer.getByRole("img", { name: "chart.png" })).toBeVisible();
    // The viewer sits in the row's React tree. A right click in it does not
    // open the row's menu.
    await viewer.getByRole("img").click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    // It pages through the strip's images.
    await viewer.getByRole("button", { name: "Next image" }).click();
    await expect(
      page.getByRole("dialog", { name: "chart-detail.png" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The keyboard opens it too, and Escape gives focus back.
    await image.focus();
    await page.keyboard.press("Enter");
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(image).toBeFocused();
    expect(opened).toEqual([]);
    expect(page.url()).toBe(url);
  });

  test("a click on the image strip's empty space opens the row", async ({
    dashboard,
    page,
  }) => {
    const { row, strip } = await openQaStrip(page, dashboard.baseURL);
    const path = await row.locator("[data-inbox-head]").getAttribute("href");
    if (!path) throw new Error("The QA row has no link.");
    const inbox = page.url();
    // Past the last image, on the strip's right side.
    const width = await strip.evaluate((element) => element.clientWidth);
    const empty = { x: width - 16, y: 80 };
    // A drag across the strip is not a click.
    await strip.dragTo(strip, {
      sourcePosition: empty,
      targetPosition: { x: empty.x - 48, y: empty.y },
    });
    expect(page.url()).toBe(inbox);
    const outlineRead = waitForOutlineRead(page, "internal:dashboard-qa");
    await strip.click({ position: empty });
    await expect(page).toHaveURL(new URL(path, dashboard.baseURL).href);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await outlineRead;
  });

  // The mock's busy row: 90 pull requests and 12 images, 3 in the feed.
  const BUSY = "Inbox comfortable rows pass";
  const BUSY_DETAIL = "/api/conversations/slack%3ACQA456%3A1770028800.000800";

  async function openConversations(page: Page, baseURL: string) {
    await page.addInitScript(() =>
      localStorage.setItem("junior:density", "comfortable"),
    );
    await page.goto(`${baseURL}/inbox?view=conversations`);
    const row = page
      .locator("li[data-inbox-row]")
      .filter({ hasText: BUSY })
      .first();
    await row.scrollIntoViewIfNeeded();
    return row;
  }

  // The images that the page asked for, by number.
  function requestedImages(page: Page): Set<number> {
    const numbers = new Set<number>();
    page.on("request", (request) => {
      const match = /\/attachments\/busy-image-(\d+)$/.exec(request.url());
      if (match) numbers.add(Number(match[1]));
    });
    return numbers;
  }

  test("a busy row lists a few pieces of linked work, and its images come first", async ({
    dashboard,
    page,
  }) => {
    const row = await openConversations(page, dashboard.baseURL);
    const work = row.getByRole("group", { name: "Linked work" });
    const lines = work.locator("[data-linked-work-card]");
    // Open work first, newest first; the 87 others fold into one button.
    await expect(lines).toHaveText([
      /^Tighten the pane spacing \(1\)#3400$/,
      /^Move the ask icons into pills \(2\)#3399$/,
      /^Load row images lazily \(3\)#3398$/,
    ]);
    // Work in another repo names its repo.
    const more = work.getByRole("button", { name: "+87 more" });
    await more.click();
    await expect(lines).toHaveCount(90);
    await expect(
      lines.filter({ hasText: /relay#\d+$/ }).first(),
    ).toBeAttached();
    // Merged and closed work comes last.
    await expect(lines.last().getByRole("img")).toHaveAccessibleName(
      /merged|closed/,
    );
    await work.getByRole("button", { name: "Show fewer" }).click();
    await expect(lines).toHaveCount(3);
    // The images sit right under the head, above the linked work.
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const strip = element.querySelector('[aria-label="Images"]');
          const list = element.querySelector('[aria-label="Linked work"]');
          return Boolean(
            strip &&
            list &&
            strip.compareDocumentPosition(list) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      )
      .toBe(true);
  });

  test("the image strip shows every image in one scrolling row, and loads each as it comes near", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1100 });
    const requested = requestedImages(page);
    const details: string[] = [];
    const eventPages: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === BUSY_DETAIL) details.push(request.url());
      if (url.pathname === `${BUSY_DETAIL}/events`) {
        eventPages.push(url.search);
      }
    });
    const row = await openConversations(page, dashboard.baseURL);
    const strip = row.getByRole("group", { name: "Images" });
    // The feed's newest 3 load at once. The strip reads nothing more until
    // the person scrolls it.
    await expect(strip.getByRole("img")).toHaveCount(3);
    await expect
      .poll(() => [...requested].sort((a, b) => a - b))
      .toEqual([7, 8, 9]);
    await page.waitForLoadState("networkidle");
    expect(details).toEqual([]);
    // It is one row that scrolls sideways.
    expect(
      await strip.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);

    // Near its end, the strip reads older batches one after another, with
    // no click, until the history runs out. The newest batch has no images,
    // and the strip still goes on.
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(strip.locator("a[data-image-tile]")).toHaveCount(6);
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(strip.locator("a[data-image-tile]")).toHaveCount(12);
    await page.waitForLoadState("networkidle");
    // The detail, then one events page per older batch, each cursor once.
    expect(details).toHaveLength(1);
    expect(eventPages).toHaveLength(2);
    expect(new Set(eventPages).size).toBe(2);
    await expect(strip.locator("[data-image-skeleton]")).toHaveCount(0);
    await expect(strip.getByRole("button")).toHaveCount(0);
    // The oldest images are far along the strip, so they wait.
    await strip.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await page.waitForLoadState("networkidle");
    expect(requested.has(6)).toBe(false);
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect.poll(() => requested.has(6)).toBe(true);
    // Each image keeps a fixed box and loads lazily.
    const last = strip.getByRole("img", { name: "screen-6.png" });
    await expect(last).toHaveAttribute("loading", "lazy");
    await expect(last).toHaveAttribute("width", "256");
    await expect(last).toHaveAttribute("height", "160");
  });
});
