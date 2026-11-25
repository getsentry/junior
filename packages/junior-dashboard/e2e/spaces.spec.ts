import { conversationMenuRow, viewAsParticipant } from "./conversationMenu";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

const BILLING = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";
const DOCS = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a23";
// A child of the mock dashboard QA Conversation.
const CHILD_ID = "junior:internal:dashboard-qa:advisor-plan";

test("the pane lists the viewer's Spaces, and a Space page shows its details", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
  const spaces = page.getByRole("list", { name: "Spaces" });
  // Only Spaces that the viewer is a member of list.
  await expect(spaces.getByRole("link")).toHaveText([
    /Billing migration$/,
    /Mobile app$/,
  ]);
  // A row in a Space links to it.
  const list = page.getByRole("region", { exact: true, name: "Conversations" });
  await expect(
    list.getByRole("link", { name: "Space: Billing migration" }).first(),
  ).toBeVisible();
  await screenshot(page, "spaces-pane", { view: "desktop" });

  await spaces.getByRole("link", { name: "Billing migration" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}${BILLING}`);
  await expect(
    page.getByRole("heading", { name: "Billing migration" }),
  ).toBeVisible();
  await expect(
    spaces.getByRole("link", { name: "Billing migration" }),
  ).toHaveAttribute("aria-current", "page");
  const details = page.getByRole("complementary", { name: "Space details" });
  await expect(
    details.getByText(
      "Move invoicing to the new billing provider without double charges.",
    ),
  ).toBeVisible();
  await expect(
    details
      .getByRole("region", { exact: true, name: "Conversations" })
      .getByRole("link", { name: /Plan the billing migration/ }),
  ).toBeVisible();
  await expect(
    details.getByRole("region", { name: "Members" }).getByText("Avery Chen"),
  ).toBeVisible();
  await screenshot(page, "space-page", { view: "desktop" });

  // A Conversation row opens it.
  await details
    .getByRole("link", { name: /Plan the billing migration/ })
    .click();
  await expect(page).toHaveURL(/\/conversations\//);
});

test("a non-member opens a Space and joins it", async ({ dashboard, page }) => {
  await page.goto(`${dashboard.baseURL}${DOCS}`);
  await expect(
    page.getByRole("heading", { name: "Docs refresh" }),
  ).toBeVisible();
  await expect(
    page.getByText("Join Docs refresh to message its Lead."),
  ).toBeVisible();
  await expect(page.getByLabel("Continue this conversation")).toHaveCount(0);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByLabel("Continue this conversation")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Spaces" }).getByRole("link", {
      name: "Docs refresh",
    }),
  ).toBeVisible();

  // A member can leave from the Space menu.
  await page.getByRole("button", { name: "Space menu" }).click();
  await page.getByRole("menuitem", { name: "Leave Space" }).click();
  await expect(page.getByRole("button", { name: "Join" })).toBeVisible();
});

test("a phone header names the Space and holds its actions", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(mobile);
  await page.goto(`${dashboard.baseURL}${DOCS}`);
  await expect(
    page.getByRole("heading", { name: "Docs refresh" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Join" }).click();
  await page.getByRole("button", { name: "Space menu" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Leave Space" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to the Inbox entries" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("archiving a Space asks first, and a restore brings back its composer", async ({
  dashboard,
  page,
}) => {
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  await page.getByRole("button", { name: "Space menu" }).click();
  await page.getByRole("menuitem", { name: "Archive Space" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("stops and archives every conversation");
  await confirm.getByRole("button", { name: "Archive" }).click();
  await expect(
    page.getByText("This Space is archived. Restore it to message its Lead."),
  ).toBeVisible();
  await expect(page.getByLabel("Continue this conversation")).toHaveCount(0);
  // An archived Space leaves the pane.
  await expect(
    page.getByRole("list", { name: "Spaces" }).getByRole("link", {
      name: "Billing migration",
    }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Space menu" }).click();
  await page.getByRole("menuitem", { name: "Restore Space" }).click();
  await expect(page.getByLabel("Continue this conversation")).toBeVisible();
});

test("creating a Space opens it", async ({ dashboard, page }) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
  await page.getByRole("button", { name: "New Space" }).click();
  const dialog = page.getByRole("dialog", { name: "New Space" });
  const create = dialog.getByRole("button", { name: "Create Space" });
  // A Space needs a name.
  await expect(create).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "Name" })
    .fill("Checkout reliability");
  await dialog
    .getByRole("textbox", { name: "Description" })
    .fill("Keep checkout fast and error-free.");
  await screenshot(page, "space-create", { view: "desktop" });
  await create.click();
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { name: "Checkout reliability" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Space details" })
      .getByText("Keep checkout fast and error-free."),
  ).toBeVisible();
  // Its new Lead introduces itself.
  await expect(
    page.getByRole("heading", { name: "This Space's Lead" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Spaces" }).getByRole("link", {
      name: "Checkout reliability",
    }),
  ).toHaveAttribute("aria-current", "page");
});

test("Move to Space moves a top-level Conversation", async ({
  dashboard,
  page,
}) => {
  await viewAsParticipant(page);
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:questions-qa")}`,
  );
  await expect(
    page.getByRole("link", { name: "Space: Billing migration" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Move to Space").click();
  const picker = page.getByRole("dialog", { name: "Move to Space" });
  // The current Space is checked, so Move waits for another choice.
  await expect(picker.getByRole("button", { name: "Move" })).toBeDisabled();
  await screenshot(page, "space-move", { view: "desktop" });
  // A search picks its first match, and Enter moves.
  await picker.getByRole("combobox", { name: "Space" }).fill("mobile");
  await expect(
    picker.getByRole("option", { name: "Mobile app" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Space: Mobile app" }),
  ).toBeVisible();

  // No Space takes it out of every Space.
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Move to Space").click();
  await page.keyboard.press("Home");
  await expect(
    picker.getByRole("option", { name: "No Space" }),
  ).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("button", { name: "Move" }).click();
  await expect(page.getByRole("link", { name: /^Space:/ })).toHaveCount(0);
});

test("a child Conversation has no Move to Space", async ({
  dashboard,
  page,
}) => {
  await viewAsParticipant(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CHILD_ID)}`,
  );
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await expect(conversationMenuRow(page, "Copy as Markdown")).toBeVisible();
  await expect(conversationMenuRow(page, "Move to Space")).toHaveCount(0);
});
