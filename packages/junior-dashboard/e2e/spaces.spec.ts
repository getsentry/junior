import { conversationMenuRow, viewAsParticipant } from "./conversationMenu";
import { desktop, mobile, screenshot } from "./screenshot";
import { findMockConversationDetail, mockSpaceList } from "./mock-reports";
import { expect, test } from "./test";

const BILLING = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";
// A private Space that the viewer and Avery are in.
const PRICING = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a24";
// A child of the mock dashboard QA Conversation.
const CHILD_ID = "junior:internal:dashboard-qa:advisor-plan";
// A top-level Conversation with no visibility.
const NON_PUBLIC_ID = "internal:history-2";

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
    /Pricing launch$/,
  ]);
  // A private Space's tile has a lock.
  await expect(
    spaces
      .getByRole("link", { name: "Pricing launch" })
      .getByRole("img", { name: "Private Space" }),
  ).toBeVisible();
  await expect(
    spaces
      .getByRole("link", { name: "Billing migration" })
      .getByRole("img", { name: "Private Space" }),
  ).toHaveCount(0);
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
  const details = page.getByRole("complementary", {
    name: "Conversation details",
  });
  const work = details.getByRole("region", { exact: true, name: "Work" });
  await work.getByRole("button", { name: "Show finished" }).click();
  await expect(
    work.getByRole("link", { name: /Plan the billing migration/ }),
  ).toBeVisible();
  await expect(
    details
      .getByRole("region", { name: "Participants" })
      .getByRole("img", { name: /^Avery Chen/ }),
  ).toBeVisible();
  await screenshot(page, "space-page", { view: "desktop" });

  // A Thread row opens it, and Back returns to the Space.
  await details
    .getByRole("link", { name: /Plan the billing migration/ })
    .click();
  await expect(page).toHaveURL(/\/conversations\//);
  await page.getByRole("link", { name: "Back to Space" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}${BILLING}`);
});

test("the pane marks the Space of an open Conversation", async ({
  dashboard,
  page,
}) => {
  const BILLING_ID = BILLING.slice("/spaces/".length);
  // No seeded child is in a Space, so this one reports its root's Space, as
  // the API does for a child.
  await page.route(
    (url) =>
      decodeURIComponent(url.pathname) === `/api/conversations/${CHILD_ID}`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const detail = await findMockConversationDetail(route);
      if (!detail) return route.fallback();
      await route.fulfill({
        json: {
          ...detail,
          space: { id: BILLING_ID, name: "Billing migration" },
        },
      });
    },
  );
  const spaces = page.getByRole("list", { name: "Spaces" });
  // Only the open Conversation's Space, if any, is the current row.
  const expectCurrentSpace = async (current?: string) => {
    for (const name of ["Billing migration", "Mobile app", "Pricing launch"]) {
      const row = spaces.getByRole("link", { name });
      if (name === current)
        await expect(row).toHaveAttribute("aria-current", "page");
      else await expect(row).not.toHaveAttribute("aria-current");
    }
  };
  // The page heading shows the detail, which names the Space.
  const open = async (conversationId: string, title: string) => {
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
    );
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  };
  // A phone shows no pane beside a Conversation, so only the desktop pane
  // marks its Space.
  await page.setViewportSize(desktop);
  await open("internal:questions-qa", "Plan the billing migration");
  await expectCurrentSpace("Billing migration");
  await screenshot(page, "space-conversation-pane", {
    lightTheme: true,
    target: page.getByRole("navigation", { name: "Primary" }),
    view: "desktop",
  });

  await open(CHILD_ID, "Review the dashboard plan");
  await expectCurrentSpace("Billing migration");

  // A one-off is in no Space.
  await open(NON_PUBLIC_ID, "Flaky test triage 2");
  await expectCurrentSpace();
});

test("each pane row shows what its Space's Conversations need", async ({
  dashboard,
  page,
}) => {
  // One state for each Space, as the API rolls them up for the viewer.
  const states: Record<string, object> = {
    "Billing migration": { latestTurnFailed: true, treeState: "needs_you" },
    "Mobile app": { latestTurnFailed: true, treeState: "working" },
    "Pricing launch": { latestTurnFailed: false, treeState: "working" },
  };
  await page.route("**/api/spaces", async (route) => {
    const body = await mockSpaceList(route);
    await route.fulfill({
      json: {
        spaces: body.spaces.map((space) => ({
          ...space,
          ...states[space.name],
        })),
      },
    });
  });
  const spaces = page.getByRole("list", { name: "Spaces" });
  const row = (name: string) => spaces.getByRole("link", { name });
  const expectStates = async () => {
    await expect(
      row("Billing migration").getByRole("img", { name: "Waiting on you" }),
    ).toBeVisible();
    // A failure outranks work that still runs.
    await expect(
      row("Mobile app").getByRole("img", { name: "A Thread failed" }),
    ).toBeVisible();
    await expect(
      row("Pricing launch").getByRole("status", { name: "Working" }),
    ).toBeVisible();
  };
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/inbox`);
  await expectStates();
  await screenshot(page, "spaces-pane-states", {
    lightTheme: true,
    target: page.getByRole("navigation", { name: "Primary" }),
    view: "desktop",
  });
  // A phone shows the pane as its own page.
  await page.setViewportSize(mobile);
  await expectStates();
  await screenshot(page, "spaces-pane-states", {
    lightTheme: true,
    view: "mobile",
  });
});

test("another Space's page does not show the last Space's Threads", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const details = page.getByRole("complementary", {
    name: "Conversation details",
  });
  const billingRow = details.getByRole("link", {
    name: /Plan the billing migration/,
  });
  await details.getByRole("button", { name: "Show finished" }).click();
  await expect(billingRow).toBeVisible();

  // Hold the next Lead's Threads, so the page shows them loading.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/conversations/") &&
      url.pathname.endsWith("/agents"),
    async (route) => {
      await held;
      await route.fallback();
    },
  );
  await page
    .getByRole("list", { name: "Spaces" })
    .getByRole("link", { name: "Mobile app" })
    .click();
  await expect(details.getByRole("img", { name: /^Riley Park/ })).toBeVisible();
  await expect(billingRow).toHaveCount(0);
  release();
  // Each Space's details start with finished Threads folded.
  await details.getByRole("button", { name: "Show finished" }).click();
  await expect(
    details.getByRole("link", { name: /SDK changelog summary 8/ }),
  ).toBeVisible();
});

test("a member leaves a public Space from the Conversation menu", async ({
  dashboard,
  page,
}) => {
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const pane = page.getByRole("list", { name: "Spaces" }).getByRole("link", {
    name: "Billing migration",
  });
  await expect(pane).toBeVisible();
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Leave").click();
  await expect(pane).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A public Space stays open, and a message to its Lead joins it again.
  await expect(page.getByLabel("Continue this conversation")).toBeVisible();
});

test("a phone header names the Space and holds its menu", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(mobile);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  await expect(
    page.getByRole("heading", { name: "Billing migration" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await expect(conversationMenuRow(page, "Leave")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Back to the Inbox entries" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("archiving a Space asks first and takes it out of the pane until a restore", async ({
  dashboard,
  page,
}) => {
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Archive").click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("stops and archives every conversation");
  await confirm.getByRole("button", { name: "Archive" }).click();
  const pane = page.getByRole("list", { name: "Spaces" }).getByRole("link", {
    name: "Billing migration",
  });
  await expect(pane).toHaveCount(0);

  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Restore").click();
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
    page.getByRole("list", { name: "Spaces" }).getByRole("link", {
      name: "Checkout reliability",
    }),
  ).toHaveAttribute("aria-current", "page");
});

test("a member renames a Space from its Lead, and edits it from the pane", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Rename").click();
  const title = page.getByRole("textbox", { name: "Conversation title" });
  await title.fill("Billing cutover");
  await title.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Billing cutover" }),
  ).toBeVisible();
  const spaces = page.getByRole("list", { name: "Spaces" });
  await expect(
    spaces.getByRole("link", { name: "Billing cutover" }),
  ).toHaveAttribute("aria-current", "page");

  await spaces
    .getByRole("link", { name: "Billing cutover" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Space" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Space" });
  const name = dialog.getByRole("textbox", { name: "Name" });
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(name).toHaveValue("Billing cutover");
  await expect(
    dialog.getByRole("textbox", { name: "Description" }),
  ).toHaveValue(
    "Move invoicing to the new billing provider without double charges.",
  );
  // A Space keeps the visibility it was created with.
  await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
  await expect(save).toBeDisabled();
  await screenshot(page, "space-edit", { lightTheme: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // A Space's row in the pane has the same menu, and the page stays.
  await spaces
    .getByRole("link", { name: "Mobile app" })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Archive Space" }),
  ).toBeVisible();
  await screenshot(page, "space-pane-menu", {
    lightTheme: true,
    view: "desktop",
  });
  await page.getByRole("menuitem", { name: "Edit Space" }).click();
  await dialog.getByRole("textbox", { name: "Name" }).fill("iOS app");
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(spaces.getByRole("link")).toHaveText([
    /Billing cutover$/,
    /iOS app$/,
    /Pricing launch$/,
  ]);
  await expect(page).toHaveURL(`${dashboard.baseURL}${BILLING}`);

  // Rows in a renamed Space name it.
  await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
  await expect(
    page
      .getByRole("region", { exact: true, name: "Conversations" })
      .getByRole("link", { name: "Space: Billing cutover" })
      .first(),
  ).toBeVisible();
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
  // The click returns before the dialog moves focus to its search. A key
  // sent sooner misses the picker.
  await expect(picker.getByRole("combobox", { name: "Space" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    picker.getByRole("option", { name: "No Space" }),
  ).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("button", { name: "Move" }).click();
  await expect(page.getByRole("link", { name: /^Space:/ })).toHaveCount(0);
});

for (const [kind, conversationId] of [
  ["child", CHILD_ID],
  // The API lets only a public Conversation join a Space.
  ["non-public", NON_PUBLIC_ID],
] as const) {
  test(`a ${kind} Conversation has no Move to Space`, async ({
    dashboard,
    page,
  }) => {
    await viewAsParticipant(page);
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
    );
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await expect(conversationMenuRow(page, "Copy as Markdown")).toBeVisible();
    await expect(conversationMenuRow(page, "Move to Space")).toHaveCount(0);
  });
}

test("creating a private Space shows its lock", async ({ dashboard, page }) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
  await page.getByRole("button", { name: "New Space" }).click();
  const dialog = page.getByRole("dialog", { name: "New Space" });
  await expect(dialog.getByRole("radio", { name: /^Public/ })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Hiring plan");
  await dialog.getByRole("radio", { name: /^Private/ }).click();
  await screenshot(page, "space-create-private", { view: "desktop" });
  await dialog.getByRole("button", { name: "Create Space" }).click();
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  // The lock shows on both private pane rows.
  await expect(
    page.getByRole("img", { name: "Private Space" }).filter({ visible: true }),
  ).toHaveCount(2);
});

test("a member invites people to a private Space's Lead", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${PRICING}`);
  const members = page
    .getByRole("complementary", { name: "Conversation details" })
    .getByRole("region", { name: "Participants" });
  await members.getByRole("button", { name: "Invite" }).click();
  const search = members.getByRole("combobox", { name: "Invite people" });
  const settled = members.getByRole("listbox", { includeHidden: true });
  await expect(search).toBeFocused();
  // Part of an email finds a person.
  await search.fill("casey@ex");
  await expect(settled).toHaveAttribute("aria-busy", "false");
  await expect(
    members.getByRole("option", { name: /Casey Nguyen/ }),
  ).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(
    members.getByRole("list", { name: "Chosen people" }).getByRole("listitem"),
  ).toHaveText(["Casey Nguyen"]);
  // A Participant shows, but cannot be chosen.
  await search.fill("avery");
  await expect(settled).toHaveAttribute("aria-busy", "false");
  const avery = members.getByRole("option", { name: /Avery Chen/ });
  await expect(avery).toHaveAttribute("aria-disabled", "true");
  await expect(avery).toContainText("Participant");
  await screenshot(page, "space-add-members", {
    lightTheme: true,
    target: members,
    view: "desktop",
  });
  await search.press("Enter");
  await search.press("Escape");
  await expect(
    members.getByRole("list", { name: "Chosen people" }).getByRole("listitem"),
  ).toHaveText(["Casey Nguyen"]);

  await members.getByRole("button", { exact: true, name: "Invite" }).click();
  await expect(search).toHaveCount(0);
  await expect(
    members.getByRole("img", { name: /^Casey Nguyen/ }),
  ).toBeVisible();
});

test("leaving a private Space leaves the page, and a non-member cannot find it", async ({
  dashboard,
  page,
}) => {
  await page.goto(`${dashboard.baseURL}${PRICING}`);
  await expect(page.getByLabel("Continue this conversation")).toBeVisible();
  // Leaving a private Lead asks first, like any private root.
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Leave").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Leave" })
    .click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(
    page
      .getByRole("list", { name: "Spaces" })
      .getByRole("link", { name: "Pricing launch" }),
  ).toHaveCount(0);
  // Back does not return to the Space or show its cached Lead.
  await page.goBack();
  await expect(page.getByLabel("Continue this conversation")).toHaveCount(0);
  await page.goto(`${dashboard.baseURL}${PRICING}`);
  await expect(page.getByText("This Space is unavailable.")).toBeVisible();
});

test("leaving a private Space from the pane leaves a Conversation in it", async ({
  dashboard,
  page,
}) => {
  await viewAsParticipant(page);
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:questions-qa")}`,
  );
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Move to Space").click();
  const picker = page.getByRole("dialog", { name: "Move to Space" });
  await picker.getByRole("combobox", { name: "Space" }).fill("pricing");
  await expect(
    picker.getByRole("option", { name: "Pricing launch" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("link", { name: "Space: Pricing launch" }),
  ).toBeVisible();

  await page
    .getByRole("list", { name: "Spaces" })
    .getByRole("link", { name: "Pricing launch" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Leave Space" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});
