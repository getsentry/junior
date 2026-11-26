import type { Page } from "@playwright/test";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

const BILLING = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";

/** Record the body of each Inbox item action that the page sends. */
function recordActions(page: Page) {
  const actions: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/actions")) {
      actions.push(request.postDataJSON());
    }
  });
  return actions;
}

test("a Space's details list what needs the viewer, and a dialog answers each in turn", async ({
  dashboard,
  page,
}) => {
  await page.clock.setFixedTime(NOW_MS);
  await page.setViewportSize(desktop);
  const actions = recordActions(page);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const details = page.getByRole("complementary", { name: "Space details" });
  const needsYou = details.getByRole("region", { name: "Needs you" });

  // The items stack under their root Conversation, as in the Inbox. A code
  // change names its state first.
  const stacks = needsYou.getByRole("region");
  await expect(stacks).toHaveCount(2);
  await expect(stacks.first()).toHaveAccessibleName(
    "Plan the billing migration",
  );
  await expect(stacks.last()).toHaveAccessibleName("Billing export check 6");
  await expect(needsYou.getByRole("button")).toHaveCount(5);
  await expect(
    needsYou.getByRole("button", { name: /^Review Skip invoices/ }),
  ).toBeVisible();
  // The pill is for the sheet. Beside the Lead, the list shows.
  await expect(page.getByRole("button", { name: /need you$/ })).toHaveCount(0);
  await screenshot(page, "space-needs-you", {
    lightTheme: true,
    view: "desktop",
  });

  await needsYou
    .getByRole("button", { name: /Choose the first migration batch/ })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Plan the billing migration",
  });
  await expect(dialog).toContainText("2 of 5");
  await expect(
    dialog
      .getByRole("button")
      .or(dialog.getByRole("link"))
      .filter({ hasText: /^(Dismiss|Snooze|Conversation|Send)$/ }),
  ).toHaveText(["Dismiss", "Snooze", "Conversation", "Send"]);
  await screenshot(page, "space-needs-you-dialog", {
    lightTheme: true,
    view: "desktop",
  });

  // A dismiss shows the next item.
  await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(dialog).toContainText("2 of 4");
  await expect(
    dialog.getByRole("heading", { name: "Handle the negative invoices" }),
  ).toBeVisible();
  await expect.poll(() => actions).toEqual([{ action: "dismiss" }]);

  // Esc closes the dialog and keeps the details.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(needsYou.getByRole("button")).toHaveCount(4);

  // After the last item, the next one is from the top.
  await needsYou.getByRole("button", { name: /^Review Skip invoices/ }).click();
  const exportDialog = page.getByRole("dialog", {
    name: "Billing export check 6",
  });
  await expect(exportDialog).toContainText("4 of 4");
  await exportDialog
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect(dialog).toContainText("1 of 3");

  // A pick and Send answer the item.
  await dialog.getByRole("button", { name: /^Sunday 02:00 UTC/ }).click();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog).toContainText("1 of 2");
  await expect
    .poll(() => actions)
    .toEqual([
      { action: "dismiss" },
      { action: "dismiss" },
      expect.objectContaining({ action: "submit" }),
    ]);

  // The dialog closes with the last item, and the empty list goes away.
  for (const left of ["1 of 2", "1 of 1"]) {
    const open = page.getByRole("dialog").filter({ hasText: left });
    await open.getByRole("button", { name: "Dismiss", exact: true }).click();
  }
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(needsYou).toBeHidden();
});

test("on a phone, a pill opens the Space's details, and an item opens its card", async ({
  dashboard,
  page,
}) => {
  await page.clock.setFixedTime(NOW_MS);
  await page.setViewportSize(mobile);
  await page.goto(`${dashboard.baseURL}${BILLING}`);

  // The pill sits above the message box and takes no focus.
  const pill = page.getByRole("button", { name: "5 need you" });
  await expect(pill).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Continue this conversation" }),
  ).not.toBeFocused();
  await screenshot(page, "space-needs-you-pill", {
    lightTheme: true,
    view: "mobile",
  });

  await pill.click();
  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect(needsYou.getByRole("button")).toHaveCount(5);
  await screenshot(page, "space-needs-you-sheet", {
    lightTheme: true,
    view: "mobile",
  });

  await needsYou
    .getByRole("button", { name: /Retry the failed invoice export/ })
    .click();
  const card = page.getByRole("dialog", { name: "Billing export check 6" });
  await expect(card).toContainText("4 of 5");
  await screenshot(page, "space-needs-you-card", {
    lightTheme: true,
    view: "mobile",
  });

  // Back returns to the list.
  await card.getByRole("button", { name: "Back" }).click();
  await expect(card).toBeHidden();
  await expect(needsYou).toBeVisible();
});
