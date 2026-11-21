import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../test";
import { screenshot } from "../screenshot";
import { viewAsParticipant } from "./conversationMenu";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";

  /** The Conversations bundle, which lists every Conversation with its menu. */
  function conversationsList(page: Page): Locator {
    return page.getByRole("region", { name: "Conversations", exact: true });
  }

  // A row's own link. Other rows' summaries can link the same Conversation
  // by its title.
  function rowLink(scope: Page | Locator, title: string): Locator {
    const page = "page" in scope ? scope.page() : scope;
    return scope
      .getByRole("link", { exact: true, name: title })
      .and(page.locator("a[data-inbox-head]"));
  }

  /** Label of the list section that holds the first row matching `title`. */
  async function sectionOf(
    list: Locator,
    title: string,
  ): Promise<string | null> {
    return list
      .locator("section[aria-label]")
      .filter({
        has: rowLink(list.page(), title),
      })
      .first()
      .getAttribute("aria-label");
  }

  test.describe("conversation rows", () => {
    test("a pin keeps its place, and Pinned only lists only the pins", async ({
      page,
      dashboard,
    }) => {
      await viewAsParticipant(page);
      await page.goto(`${dashboard.baseURL}/?view=conversations`);
      const list = conversationsList(page);
      const title = "Investigate checkout latency";
      const row = rowLink(list, title);
      await expect(row).toBeVisible();
      const section = await sectionOf(list, title);
      await expect(list.getByRole("region", { name: "Pinned" })).toHaveCount(0);

      // Pin from the row's hover action.
      const pinRequest = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" && request.url().endsWith("/pin"),
      );
      await row.hover();
      await list.getByRole("button", { name: `Pin ${title}` }).click();
      expect((await pinRequest).postDataJSON()).toEqual({ pinned: true });

      // The row stays in its time section, and In flight lists it.
      await row.hover();
      await expect(
        list.getByRole("button", { name: `Unpin ${title}` }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => sectionOf(list, title)).toBe(section);
      await expect(list.getByRole("region", { name: "Pinned" })).toHaveCount(0);
      await expect(
        page
          .getByRole("list", { name: "In flight" })
          .getByRole("link", { name: new RegExp(title) }),
      ).toBeVisible();

      // Pinned only shows only the pin, also after a reload.
      const pinnedOnly = page
        .getByRole("navigation", { name: "Rows to show" })
        .getByRole("link", { name: "Pinned only" });
      await pinnedOnly.click();
      await expect(page).toHaveURL(/[?&]pinned=1/);
      await expect(pinnedOnly).toHaveAttribute("aria-current", "page");
      const rows = list.locator("a[data-inbox-head]");
      await expect(rows).toHaveCount(1);
      await expect(row).toBeVisible();
      await page.reload();
      await expect(pinnedOnly).toHaveAttribute("aria-current", "page");
      await expect(rows).toHaveCount(1);
      await screenshot(page, "conversations-pinned-only", {
        lightTheme: true,
        view: "desktop",
      });

      // An unpin takes the row out of the list, and the empty state says
      // how to pin.
      await row.hover();
      const unpin = list.getByRole("button", { name: `Unpin ${title}` });
      await expect(unpin).toHaveAttribute("aria-pressed", "true");
      await unpin.click();
      await expect(row).toHaveCount(0);
      await expect(page.getByText(/^Nothing pinned\./)).toBeVisible();

      // Off again, every row shows.
      await pinnedOnly.click();
      await expect(page).not.toHaveURL(/[?&]pinned=1/);
      await expect(row).toBeVisible();
      await expect.poll(() => sectionOf(list, title)).toBe(section);
    });

    test("lists the rows of the conversation menu in the row menu", async ({
      page,
      dashboard,
    }) => {
      await viewAsParticipant(page);
      await page.goto(`${dashboard.baseURL}/?view=conversations`);
      const list = conversationsList(page);
      const finishedRow = list.getByRole("link", {
        name: /Closed issue summary/,
      });
      await finishedRow.click({ button: "right" });
      // The row menu shows the rows of the `⋯` menu, in the same order.
      await expect(page.getByRole("menuitem")).toHaveText([
        "Share",
        "Copy as Markdown",
        "Open event log",
        "Pin",
        "Rename",
        "Subscribe",
        "Archive",
      ]);
      await screenshot(page, "conversation-row-context-menu", {
        lightTheme: true,
        view: "desktop",
      });
    });

    test("renames a conversation from the row menu", async ({
      page,
      dashboard,
    }) => {
      await viewAsParticipant(page);
      await page.goto(`${dashboard.baseURL}/?view=conversations`);
      const list = conversationsList(page);
      const renameRequest = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" && request.url().endsWith("/title"),
      );
      await list
        .getByRole("link", { name: /Closed issue summary/ })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const titleInput = page.getByRole("textbox", { name: "Title" });
      await expect(titleInput).toBeFocused();
      await expect(titleInput).toHaveValue("Closed issue summary");
      await titleInput.fill("  Closed issue follow-up ");
      await page.getByRole("button", { name: "Save" }).click();
      expect((await renameRequest).postDataJSON()).toEqual({
        title: "Closed issue follow-up",
      });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const renamedRow = list.getByRole("link", {
        name: /Closed issue follow-up/,
      });
      await expect(renamedRow).toBeVisible();

      await page.reload();
      await expect(renamedRow).toBeVisible();

      // The `⋯` menu renames too.
      await page.goto(
        `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
      );
      await page.getByRole("button", { name: "Conversation menu" }).click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
        "Investigate checkout latency",
      );
    });
  });
});
