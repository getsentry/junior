import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { screenshot } from "./screenshot";
import { viewAsParticipant } from "./conversationMenu";
import { openRow } from "./inbox-fixture";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";

/** The Conversations bundle, which lists every Conversation with its menu. */
function conversationsList(page: Page): Locator {
  return page.getByRole("region", { name: "Conversations", exact: true });
}

/** Label of the list section that holds the first row matching `title`. */
async function sectionOf(
  list: Locator,
  title: string,
): Promise<string | undefined> {
  return list
    .locator("section[aria-label]")
    .filter({
      has: list.page().getByRole("link", { exact: true, name: title }),
    })
    .first()
    .getAttribute("aria-label");
}

test.describe("conversation rows", () => {
  test("pinning moves a conversation to Pinned and In flight", async ({
    page,
    dashboard,
  }) => {
    await viewAsParticipant(page);
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    const list = conversationsList(page);
    // Other rows' summaries link to it too, by its chip.
    const row = list.getByRole("link", {
      exact: true,
      name: "Investigate checkout latency",
    });
    await expect(row).toBeVisible();
    await expect
      .poll(() => sectionOf(list, "Investigate checkout latency"))
      .not.toBe("Pinned");

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

    // The row shows only in Pinned, and In flight lists it.
    await expect(row).toHaveCount(1);
    await expect
      .poll(() => sectionOf(list, "Investigate checkout latency"))
      .toBe("Pinned");
    await expect(
      page
        .getByRole("list", { name: "In flight" })
        .getByRole("link", { name: /Investigate checkout latency/ }),
    ).toBeVisible();
    await row.hover();
    await expect(
      list.getByRole("button", { name: "Unpin Investigate checkout latency" }),
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
    await expect
      .poll(() => sectionOf(list, "Investigate checkout latency"))
      .not.toBe("Pinned");
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
