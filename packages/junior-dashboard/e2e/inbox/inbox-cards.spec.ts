import type { Page } from "@playwright/test";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
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
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
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
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
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
    // Compact rows name each piece of work by its title and number, in its
    // status color, on one line.
    await expect(release.locator("[data-linked-work-card]")).toHaveCount(0);
    const chips = release.locator("[data-linked-work-chip]");
    await expect(chips.first()).toHaveText(
      "Return 429 before parsing oversized envelopes#44",
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
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
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

  // The mock's busy row: 90 pull requests and 12 images, 3 in the feed.
  const BUSY = "Inbox comfortable rows pass";
  const BUSY_DETAIL = "/api/conversations/slack%3ACQA456%3A1770028800.000800";

  async function openConversations(page: Page, baseURL: string) {
    await page.addInitScript(() =>
      localStorage.setItem("junior:density", "comfortable"),
    );
    await page.goto(`${baseURL}/?view=conversations`);
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
    // Open work first, newest first; the 86 others fold into one button.
    await expect(lines).toHaveText([
      /^Tighten the pane spacing \(1\)#3400$/,
      /^Move the ask icons into pills \(2\)#3399$/,
      /^Load row images lazily \(3\)#3398$/,
      /^Fold linked work into one line \(4\)#3397$/,
    ]);
    // Work in another repo names its repo.
    const more = work.getByRole("button", { name: "+86 more" });
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
    await expect(lines).toHaveCount(4);
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
    // An open row lists a few more.
    await row.locator('a[aria-controls^="inbox-row-"]').first().click();
    await expect(row).toHaveAttribute("data-expanded", "true");
    await expect(lines).toHaveCount(6);
  });

  test("the image strip shows every image in one scrolling row, and loads each as it comes near", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1100 });
    const requested = requestedImages(page);
    const details: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === BUSY_DETAIL) {
        details.push(request.url());
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

    // Near its end, the strip reads the older images.
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect.poll(() => details.length).toBe(1);
    await expect(strip.locator("a[data-image-tile]")).toHaveCount(12);
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

  test("the strip asks for older images with a button when it does not scroll", async ({
    dashboard,
    page,
  }) => {
    const row = await openConversations(page, dashboard.baseURL);
    const strip = row.getByRole("group", { name: "Images" });
    await expect(strip.getByRole("img")).toHaveCount(3);
    await strip.getByRole("button", { name: "Older images" }).click();
    await expect(strip.locator("a[data-image-tile]")).toHaveCount(12);
    // All of them are read, so the button goes.
    await expect(
      strip.getByRole("button", { name: "Older images" }),
    ).toHaveCount(0);
  });
});
