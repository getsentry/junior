import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../test";
import { screenshot } from "../screenshot";
import { viewAsParticipant } from "./conversationMenu";
import { openRow } from "./inbox-fixture";

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
      .and(page.locator('a[aria-controls^="inbox-row-"]'));
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
    test("a pin keeps its row in place and joins In flight", async ({
      page,
      dashboard,
    }) => {
      await viewAsParticipant(page);
      await page.goto(`${dashboard.baseURL}/?view=conversations`);
      const list = conversationsList(page);
      const row = rowLink(list, "Investigate checkout latency");
      await expect(row).toBeVisible();
      const section = await sectionOf(list, "Investigate checkout latency");
      expect(section).not.toBeNull();

      // Pin from the row's hover action.
      const pinRequest = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" && request.url().endsWith("/pin"),
      );
      await row.hover();
      await list
        .getByRole("button", { name: "Pin Investigate checkout latency" })
        .click();
      expect((await pinRequest).postDataJSON()).toEqual({ pinned: true });

      // The row stays in its section, with its pin marker, and In flight
      // lists it. No Pinned section groups pins. The marker shows when the
      // pointer leaves the row.
      await page.mouse.move(0, 0);
      const marker = list
        .locator(`[data-inbox-row="conversation:${ACTIVE_CONVERSATION_ID}"]`)
        .getByRole("img", { name: "Pinned" });
      await expect(marker).toBeVisible();
      await expect(row).toHaveCount(1);
      await expect(
        page
          .getByRole("list", { name: "In flight" })
          .getByRole("link", { name: /Investigate checkout latency/ }),
      ).toBeVisible();
      await expect(list.getByRole("region", { name: "Pinned" })).toHaveCount(0);
      expect(await sectionOf(list, "Investigate checkout latency")).toBe(
        section,
      );
      await row.hover();
      await expect(
        list.getByRole("button", {
          name: "Unpin Investigate checkout latency",
        }),
      ).toHaveAttribute("aria-pressed", "true");
      await screenshot(page, "conversations-pinned", {
        lightTheme: true,
        view: "desktop",
      });

      // Unpin from the conversation `⋯` menu.
      await openRow(row);
      await page.getByRole("button", { name: "Conversation menu" }).click();
      await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
      await expect(
        page.getByRole("menuitem", { name: "Pin", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("link", { name: "Back to Conversations" }).click();
      await expect(row).toBeVisible();
      await expect(marker).toHaveCount(0);
      expect(await sectionOf(list, "Investigate checkout latency")).toBe(
        section,
      );
    });

    test("Pinned only shows only pins, after a reload too", async ({
      page,
      dashboard,
    }) => {
      await viewAsParticipant(page);
      await page.goto(`${dashboard.baseURL}/?view=conversations`);
      const list = conversationsList(page);
      const pinnedRow = rowLink(list, "Investigate checkout latency");
      const otherRow = rowLink(list, "Closed issue summary");
      await expect(otherRow).toBeVisible();
      await pinnedRow.hover();
      await list
        .getByRole("button", { name: "Pin Investigate checkout latency" })
        .click();
      await expect(
        list.getByRole("button", {
          name: "Unpin Investigate checkout latency",
        }),
      ).toHaveCount(1);

      const filter = page.getByRole("link", { name: "Pinned only" });
      await expect(filter).not.toHaveAttribute("aria-current");
      await filter.click();
      await expect(page).toHaveURL(/[?&]pinned=1\b/);
      await expect(filter).toHaveAttribute("aria-current", "page");
      await expect(pinnedRow).toBeVisible();
      await expect(otherRow).toHaveCount(0);

      // The filter is in the URL, so a reload keeps it.
      await page.reload();
      await expect(filter).toHaveAttribute("aria-current", "page");
      await expect(pinnedRow).toBeVisible();
      await expect(otherRow).toHaveCount(0);

      // An unpin takes the row out of the filtered list.
      await pinnedRow.hover();
      await list
        .getByRole("button", { name: "Unpin Investigate checkout latency" })
        .click();
      await expect(pinnedRow).toHaveCount(0);
      await expect(
        list.getByText(
          "Nothing pinned. Pin a conversation from its row or its menu.",
        ),
      ).toBeVisible();

      await filter.click();
      await expect(page).not.toHaveURL(/[?&]pinned=/);
      await expect(otherRow).toBeVisible();
    });

    test("Pinned only on the Inbox says how to pin when nothing is", async ({
      page,
      dashboard,
    }) => {
      await page.goto(`${dashboard.baseURL}/?pinned=1`);
      const inbox = page.getByRole("region", { name: "Inbox", exact: true });
      await expect(
        inbox.getByText(
          "Nothing pinned. Pin a conversation from its row or its menu.",
        ),
      ).toBeVisible();
      await expect(
        inbox.getByRole("link", { name: "Pinned only" }),
      ).toHaveAttribute("aria-current", "page");
      await expect(inbox.getByRole("region", { name: "To do" })).toHaveCount(0);
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
