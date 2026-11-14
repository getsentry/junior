import { expect, test } from "./test";

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
  // Newest first, each with its title and status.
  await expect(work.getByRole("link")).toHaveText([
    /Update Junior to 0\.288\.0.*getsentry\/junior#2201 · Draft/,
    /Pin the release train to payments 4\.2.*getsentry\/payments#91 · Open/,
    /Return 429 before parsing oversized envelopes.*getsentry\/relay#44 · Merged/,
  ]);
  // Quiet cards: no icon, and a line in each one's status color.
  const cards = work.locator("[data-linked-work-card]");
  await expect(cards.locator("svg")).toHaveCount(0);
  await expect
    .poll(() =>
      cards
        .locator("[data-status-tone]")
        .evaluateAll((lines) =>
          lines.map((line) => line.getAttribute("data-status-tone")),
        ),
    )
    .toEqual(["neutral", "success", "accent"]);
  await expect(
    work.getByRole("link", { name: /Pin the release train/ }),
  ).toHaveAttribute("href", "https://github.com/getsentry/payments/pull/91");
  // Work saved without a title follows as one quiet line, with no link.
  const qa = page
    .locator("[data-inbox-row]")
    .filter({ hasText: "Dashboard QA edge cases" })
    .first();
  await expect(qa.getByRole("group", { name: "Linked work" })).toBeAttached();
  await expect(qa.getByRole("link", { name: /getsentry/ })).toHaveCount(0);
  await expect(qa.locator("[data-linked-work-chip]").first()).toBeAttached();
  // Its newest files: images as lazy thumbnails, other files by name.
  const files = qa.getByRole("group", { name: "Files" });
  await expect(files.getByRole("link")).toHaveCount(3);
  for (const name of ["chart.png", "chart-detail.png"]) {
    const thumbnail = files.getByRole("img", { name, exact: true });
    await expect(thumbnail).toHaveAttribute("loading", "lazy");
    await expect(thumbnail).toHaveAttribute(
      "src",
      /\/attachments\/qa-chart-png$/,
    );
  }
  await expect(files.getByRole("link", { name: "demo.mp4" })).toBeAttached();
  // A pull request card shows the first image of its description.
  const preview = page
    .locator("[data-inbox-row]")
    .filter({ hasText: "Investigate checkout latency" })
    .first()
    .getByRole("img", {
      name: "Preview of Retry checkout writes after lock timeouts",
    });
  // The mock serves the preview itself.
  await expect(preview).toHaveAttribute("src", /\/api\/images\/checkout-p95$/);
  await preview.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      preview.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);

  await density("compact");
  await expect(qa.getByRole("group", { name: "Files" })).toHaveCount(0);
  // Compact rows name each piece of work by its title and number, in its
  // status color, on one line.
  await expect(release.locator("[data-linked-work-card]")).toHaveCount(0);
  const chips = release.locator("[data-linked-work-chip]");
  await expect(chips.first()).toHaveText("Update Junior to 0.288.0#2201");
  await expect(chips.first().locator("[data-status-tone]")).toHaveAttribute(
    "data-status-tone",
    "neutral",
  );
});

test("a linked-work preview that fails to load leaves no empty box", async ({
  dashboard,
  page,
}) => {
  await page.route("**/api/images/checkout-p95", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.addInitScript(() =>
    localStorage.setItem("junior:density", "comfortable"),
  );
  await page.goto(`${dashboard.baseURL}/?view=conversations`);
  const card = page
    .locator("[data-inbox-row]")
    .filter({ hasText: checkout })
    .first()
    .locator("[data-linked-work-card]")
    .filter({ hasText: "Retry checkout writes after lock timeouts" });
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(card.getByRole("img")).toHaveCount(0);
});
