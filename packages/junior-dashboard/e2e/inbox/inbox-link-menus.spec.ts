import type { Page } from "@playwright/test";

import { mobile, screenshot } from "../screenshot";
import { expect, test } from "../test";
import { holdTouch, rightClickCancelled } from "./browserMenu";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const TITLE = "Investigate checkout latency";
  const RUNBOOK = "https://runbooks.example.com/checkout";
  const THREAD = "slack:CQA456:1770021600.000600";
  // A point on the summary's first word, which is not a link.
  const ON_TEXT = { x: 4, y: 8 };

  // Give the row's summary a link to another site and one to this
  // dashboard.
  async function summaryWithLinks(page: Page, baseURL: string) {
    const thread = `${baseURL}/conversations/${encodeURIComponent(THREAD)}`;
    await page.route(
      (url) => url.pathname === "/api/conversations",
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch().catch(() => undefined);
        if (!response) return route.abort().catch(() => {});
        const body = await response.json();
        const conversations = body.conversations?.map(
          (conversation: Record<string, unknown>) =>
            conversation["displayTitle"] === TITLE
              ? {
                  ...conversation,
                  summary: `Follow [the runbook](${RUNBOOK}) and [the Thread](${thread}).`,
                }
              : conversation,
        );
        await route.fulfill({ json: { ...body, conversations }, response });
      },
    );
  }

  async function openRow(page: Page, baseURL: string) {
    await summaryWithLinks(page, baseURL);
    await page.goto(`${baseURL}/inbox?view=conversations`);
    const row = page
      .getByRole("region", { exact: true, name: "Conversations" })
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { exact: true, name: TITLE }) })
      .first();
    const runbook = row.getByRole("link", { name: "the runbook" });
    await expect(runbook).toBeVisible();
    return {
      row,
      runbook,
      text: row.getByText(/^Follow/),
      thread: row.getByRole("link", { name: "the Thread" }),
    };
  }

  test("a link on a closed card gets the browser's menu, and opens another site in a new tab", async ({
    dashboard,
    page,
  }) => {
    const { row, runbook, text, thread } = await openRow(
      page,
      dashboard.baseURL,
    );
    const menu = page.getByRole("menu");
    await screenshot(page, "inbox-card-links", {
      lightTheme: true,
      target: row,
    });

    // A right-click on a link leaves the menu to the browser.
    for (const link of [runbook, thread]) {
      expect(await rightClickCancelled(link)).toBe(false);
      await expect(menu).toHaveCount(0);
    }
    // Elsewhere on the card, and on its title, it opens the row menu.
    await text.click({ button: "right", position: ON_TEXT });
    await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await row
      .getByRole("link", { exact: true, name: TITLE })
      .click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await page.keyboard.press("Escape");

    // A link to another site opens in a new tab, with the outbound icon. A
    // link to this dashboard stays in the tab.
    await expect(runbook).toHaveAttribute("target", "_blank");
    await expect(runbook.getByRole("img", { includeHidden: true })).toHaveCount(
      1,
    );
    await expect(thread).not.toHaveAttribute("target", /.*/);
  });

  test.describe("on a touch phone", () => {
    test.use({
      controlTimers: true,
      hasTouch: true,
      viewport: { height: mobile.height, width: mobile.width },
    });

    test("a long press on a link opens no row menu", async ({
      dashboard,
      page,
    }) => {
      const { runbook, text } = await openRow(page, dashboard.baseURL);
      const menu = page.getByRole("menu");

      // Past the long press delay, the row menu has not opened.
      let lift = await holdTouch(page, runbook, { x: 4, y: 4 });
      await page.clock.runFor(1_000);
      await expect(menu).toHaveCount(0);
      await lift();

      // A long press elsewhere on the card still opens it.
      lift = await holdTouch(page, text, ON_TEXT);
      await page.clock.runFor(1_000);
      await expect(
        menu.getByRole("menuitem", { name: "Rename" }),
      ).toBeVisible();
      await lift();
    });
  });
});
