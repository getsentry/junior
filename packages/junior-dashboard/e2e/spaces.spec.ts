import type { ConversationSummaryReport } from "@sentry/junior/api/schema";

import { conversationMenuRow, viewAsParticipant } from "./conversationMenu";
import { desktop, mobile, screenshot } from "./screenshot";
import { expect, test } from "./test";

const BILLING_ID = "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";
const BILLING = `/spaces/${BILLING_ID}`;
const DOCS = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a23";
const MOBILE_APP_ID = "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a22";
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

  // A Conversation row opens it, and Back returns to the Space.
  await details
    .getByRole("link", { name: /Plan the billing migration/ })
    .click();
  await expect(page).toHaveURL(/\/conversations\//);
  await page.getByRole("link", { name: "Back to Space" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}${BILLING}`);
});

test("each pane row shows what its Space's Conversations need, and the Space's page lists them in order", async ({
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
    const response = await route.fetch();
    const body = (await response.json()) as {
      spaces: { name: string }[];
    };
    await route.fulfill({
      json: {
        spaces: body.spaces.map((space) => ({
          ...space,
          ...states[space.name],
        })),
      },
      response,
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
      row("Mobile app").getByRole("img", { name: "A Conversation failed" }),
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

  // The Space's page lists its Conversations in In flight's order: pins,
  // then what waits on the viewer, then the rest, then done. Each group
  // runs newest Message first.
  await page.route(
    (url) =>
      url.pathname === "/api/conversations" &&
      url.searchParams.get("spaceId") === BILLING_ID,
    async (route) => {
      const response = await route.fetch();
      const feed = await response.json();
      // Row `index` had its last Message `index` hours before the first.
      const newest = Date.parse(feed.conversations[0].lastSeenAt);
      const row = (
        index: number,
        displayTitle: string,
        fields: Partial<ConversationSummaryReport>,
      ) => {
        const at = new Date(newest - index * 3_600_000).toISOString();
        return {
          ...feed.conversations[0],
          conversationId: `internal:space-order-${index}`,
          displayTitle,
          lastMessageAt: at,
          lastSeenAt: at,
          latestTurnFailed: false,
          pinnedAt: null,
          status: "done",
          threads: undefined,
          treeState: "done",
          turnActive: false,
          watching: false,
          ...fields,
        };
      };
      await route.fulfill({
        json: {
          ...feed,
          conversations: [
            row(0, "Done recently", {}),
            row(1, "Running", {
              status: "working",
              treeState: "working",
              turnActive: true,
            }),
            row(2, "Failed", { latestTurnFailed: true }),
            row(3, "Asks you", {
              status: "needs_input",
              treeState: "needs_you",
            }),
            row(4, "Pinned", { pinnedAt: "2026-08-01T10:00:00.000Z" }),
            row(5, "Done earlier", {}),
          ],
          nextCursor: undefined,
        },
        response,
      });
    },
  );
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const conversations = page
    .getByRole("complementary", { name: "Space details" })
    .getByRole("region", { exact: true, name: "Conversations" });
  await conversations.getByRole("button", { name: "Show 3 more" }).click();
  const rows = conversations.getByRole("listitem");
  await expect(rows).toHaveText([
    /Pinned/,
    /Asks you/,
    /Running/,
    /Failed/,
    /Done recently/,
    /Done earlier/,
    /Show fewer/,
  ]);
  // Rows carry In flight's icons, and a failed Turn. Done rows show none.
  await expect(rows.nth(0).getByRole("img", { name: "Pinned" })).toBeVisible();
  await expect(
    rows.nth(1).getByRole("img", { name: "Waiting on you" }),
  ).toBeVisible();
  await expect(
    rows.nth(2).getByRole("status", { name: "Working" }),
  ).toBeVisible();
  await expect(rows.nth(3).getByRole("img", { name: "Failed" })).toBeVisible();
  await expect(rows.nth(4).getByRole("img")).toHaveCount(0);
  // No row shows its hover fill in the shot.
  await page.mouse.move(0, 0);
  await screenshot(page, "space-page-conversations", {
    lightTheme: true,
    target: conversations,
    view: "desktop",
  });

  // A phone shows the same order in the details sheet.
  await page.setViewportSize(mobile);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  await page.getByRole("button", { name: "Space details" }).click();
  const sheet = page.getByRole("dialog", { name: "Space details" });
  await expect(
    sheet
      .getByRole("region", { exact: true, name: "Conversations" })
      .getByRole("listitem"),
  ).toHaveText([/Pinned/, /Asks you/, /Running/, /Show 3 more/]);
  await screenshot(page, "space-page-conversations", {
    lightTheme: true,
    view: "mobile",
  });
});

test("a Space's page shows its settings when they are opened", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const details = page.getByRole("complementary", { name: "Space details" });
  const settings = details.getByRole("region", { name: "Settings" });
  // Settings load only when opened.
  await expect(settings.getByText("github.repo")).toHaveCount(0);
  await settings.getByRole("button", { name: "Show" }).click();
  await expect(settings.getByText("github.repo")).toBeVisible();
  await expect(settings.getByText("getsentry/junior")).toBeVisible();
  await screenshot(page, "space-settings", {
    target: settings,
    view: "desktop",
  });
  // Junior changes settings, so the page has no controls for them.
  await expect(settings.getByRole("textbox")).toHaveCount(0);

  await page.goto(`${dashboard.baseURL}${DOCS}`);
  const docsSettings = page
    .getByRole("complementary", { name: "Space details" })
    .getByRole("region", { name: "Settings" });
  await docsSettings.getByRole("button", { name: "Show" }).click();
  await expect(
    docsSettings.getByText("No settings. Ask Junior to set one."),
  ).toBeVisible();
});

test("another Space's page does not show the last Space's Conversations", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const details = page.getByRole("complementary", { name: "Space details" });
  const billingRow = details.getByRole("link", {
    name: /Plan the billing migration/,
  });
  await expect(billingRow).toBeVisible();

  // Hold the next Space's list, so the page shows it loading.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) =>
      url.pathname === "/api/conversations" &&
      url.searchParams.get("spaceId") === MOBILE_APP_ID,
    async (route) => {
      await held;
      await route.fallback();
    },
  );
  await page
    .getByRole("list", { name: "Spaces" })
    .getByRole("link", { name: "Mobile app" })
    .click();
  await expect(details.getByText("Riley Park")).toBeVisible();
  await expect(billingRow).toHaveCount(0);
  release();
  await expect(
    details.getByRole("link", { name: /SDK changelog summary 8/ }),
  ).toBeVisible();
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

test("creating a private Space shows its lock, and its last member cannot leave", async ({
  dashboard,
  page,
}) => {
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
  // The lock shows on the Space's header and on both private pane rows.
  await expect(
    page.getByRole("img", { name: "Private Space" }).filter({ visible: true }),
  ).toHaveCount(3);

  await page.getByRole("button", { name: "Space menu" }).click();
  await page.getByRole("menuitem", { name: "Leave Space" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The last member can't leave a private Space.",
  );
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
});

test("a member adds a person to a private Space by email", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${PRICING}`);
  const members = page
    .getByRole("complementary", { name: "Space details" })
    .getByRole("region", { name: "Members" });
  await members.getByRole("button", { name: "Add" }).click();
  const email = members.getByRole("textbox", { name: "Email" });
  await email.fill("nobody@example.com");
  await members.getByRole("button", { name: "Add member" }).click();
  await expect(members.getByText("No person has that email.")).toBeVisible();
  await email.fill("casey@example.com");
  await members.getByRole("button", { name: "Add member" }).click();
  await expect(members.getByText("Casey Nguyen")).toBeVisible();
  await expect(email).toHaveCount(0);
});

test("leaving a private Space leaves the page, and a non-member cannot find it", async ({
  dashboard,
  page,
}) => {
  await page.goto(`${dashboard.baseURL}${PRICING}`);
  // A member talks to the Lead of a private Space without being one of
  // its Participants first.
  await expect(page.getByLabel("Continue this conversation")).toBeVisible();
  await page.getByRole("button", { name: "Space menu" }).click();
  await page.getByRole("menuitem", { name: "Leave Space" }).click();
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
