import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import type { Page } from "@playwright/test";

import { mockLandingAutomationApis } from "./automation-landing-fixture";
import { mockReviewItems, rollout } from "./inbox-fixture";
import { expect, test } from "./test";

const CHECKOUT_TRIAGE_ID = "slack:CQA123:1770000000.000100";
const CLOSED_ISSUE_ID = "agent-dispatch:event-1";

const question = {
  addedByConversationId: CLOSED_ISSUE_ID,
  assignedToEveryone: false,
  assignees: [
    {
      displayName: "Dashboard User",
      email: "dev@example.com",
      userId: "u-dev",
    },
  ],
  body: "The rollback is ready.",
  canAct: true,
  canTake: false,
  conversationIds: [CLOSED_ISSUE_ID],
  createdAt: "2026-08-07T08:00:00.000Z",
  id: "item-rollback",
  kind: "action" as const,
  request: {
    question: "Roll back payments-v42?",
    fields: [
      {
        id: "go",
        kind: "choice",
        label: "Rollback",
        options: [{ label: "Roll back" }, { label: "Hold" }],
      },
    ],
  },
  status: "open" as const,
  title: "Approve the payments-v42 rollback",
  updatedAt: "2026-08-07T08:30:00.000Z",
  visibility: "public" as const,
};

/**
 * Make the viewer a participant, so the Conversation has a reply box. With
 * `reviewItemId`, Junior added that Review item last.
 */
async function routeAsParticipant(
  page: Page,
  conversationId: string,
  reviewItemId?: string,
) {
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}*`,
    async (route) => {
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          [CONVERSATION_DETAIL_VERSION_HEADER]: "",
        },
      });
      const detail = await response.json();
      const last = detail.events.at(-1);
      const events = reviewItemId
        ? [
            ...detail.events,
            {
              createdAt: last.createdAt,
              data: {
                calls: [
                  {
                    name: "addReviewItem",
                    output: { item: { id: reviewItemId } },
                    status: "completed",
                    toolCallId: "add-review-item",
                  },
                ],
                type: "tool_calls",
              },
              seq: last.seq + 1,
            },
          ]
        : detail.events;
      await route.fulfill({
        response,
        json: { ...detail, events, isParticipant: true },
      });
    },
  );
}

test("switches conversations from the command palette without a server search", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  // Rows must not wait on the server search.
  await page.route(/\/api\/conversations\?q=/, (route) => route.abort());
  await routeAsParticipant(page, CHECKOUT_TRIAGE_ID);
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const input = palette.getByRole("combobox");
  await expect(input).toBeFocused();
  // The Conversations tab shows, so its recent rows lead under its name.
  await expect(palette.getByRole("group").first()).toHaveAccessibleName(
    "Conversations",
  );

  // Scattered letters match.
  await input.fill("chk tri");
  const results = palette.getByRole("group", { name: "Conversations" });
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(
    results.getByRole("option", { name: /Checkout latency triage/ }),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");

  await expect(palette).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Checkout latency triage" }),
  ).toBeVisible();
  // The reader switched to talk there, so the reply box takes focus.
  await expect(
    page.getByRole("textbox", { name: "Continue this conversation" }),
  ).toBeFocused();

  // The open conversation is not a row, so Enter switches away from it.
  await page.getByRole("button", { name: "Search" }).click();
  await expect(input).toBeFocused();
  await expect(
    palette.getByRole("option", { name: /Checkout latency triage/ }),
  ).toHaveCount(0);
  // A typo still matches.
  await input.fill("chekcout");
  await expect(
    palette.getByRole("option", { name: /Investigate checkout latency/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("a palette switch focuses the question while Junior waits for an answer", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await routeAsParticipant(page, CLOSED_ISSUE_ID, question.id);
  // The question sits on a second page that loads after the reply box
  // shows.
  let releaseQuestion = () => {};
  const questionHeld = new Promise<void>((resolve) => {
    releaseQuestion = resolve;
  });
  // A third page loads after the reader starts to type.
  let lastPageSent = false;
  let releaseLastPage = () => {};
  const lastPageHeld = new Promise<void>((resolve) => {
    releaseLastPage = resolve;
  });
  await page.route(`**/api/review-items?*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("conversationId") !== CLOSED_ISSUE_ID) {
      return route.fallback();
    }
    const cursor = url.searchParams.get("cursor");
    if (!cursor) {
      return route.fulfill({ json: { items: [], nextCursor: "page-2" } });
    }
    if (cursor === "page-2") {
      await questionHeld;
      return route.fulfill({
        json: { items: [question], nextCursor: "page-3" },
      });
    }
    await lastPageHeld;
    await route.fulfill({ json: { items: [] } });
    lastPageSent = true;
  });
  await page.goto(dashboard.baseURL);

  await page.keyboard.press("ControlOrMeta+k");
  const input = page
    .getByRole("dialog", { name: "Go to conversation" })
    .getByRole("combobox");
  await input.fill("closed issue");
  await input.press("Enter");
  const composer = page.getByLabel("Continue this conversation");
  await expect(composer).toBeVisible();

  // The question takes focus, so a number key answers it at once.
  releaseQuestion();
  const docked = page.getByRole("region", {
    name: `Question: ${question.title}`,
  });
  await expect(docked).toBeFocused();
  await expect(composer).toBeVisible();

  // The last page does not take the focus back from the message box.
  await composer.click();
  await composer.pressSequentially("Hold on");
  releaseLastPage();
  await expect.poll(() => lastPageSent).toBe(true);
  // Let the app render the last page before the next keys.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await composer.pressSequentially(" 1");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Hold on 1");
});

test("jumps to a page from the command palette", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  // A page outside the tabs, so no tab's rows lead.
  await page.goto(`${dashboard.baseURL}/settings`);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const input = palette.getByRole("combobox");
  await expect(palette.getByRole("group", { name: "Recent" })).toBeVisible();
  // The highlighted recent conversation still matches "co" loosely, but the
  // page whose name starts with it ranks first and takes Enter.
  await input.fill("co");
  await input.press("Enter");

  await expect(page).toHaveURL(/\/code$/);
  await expect(palette).toHaveCount(0);
});

test("ranks the active tab's results first", async ({ page, dashboard }) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await mockReviewItems(page);
  await mockLandingAutomationApis(page);
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  for (const [path, group] of [
    ["/automations", "Automations"],
    // The Inbox tab ranks its Conversations first.
    ["/", "Conversations"],
  ] as const) {
    await page.goto(`${dashboard.baseURL}${path}`);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette.getByRole("group").first()).toHaveAccessibleName(
      group,
    );
    await page.keyboard.press("Escape");
  }

  // A match in an Automation's instruction comes from the server.
  await page.goto(`${dashboard.baseURL}/automations`);
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("announcement post");
  const automations = palette.getByRole("group").first();
  await expect(automations).toHaveAccessibleName("Automations");
  await expect(automations.getByRole("option").first()).toHaveAccessibleName(
    /Fair Source PR review/,
  );
  await page.keyboard.press("Escape");
  await page.goto(dashboard.baseURL);

  // On the Inbox, a match in an item's body text shows, and picking it
  // opens the list with that item's row expanded.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("canary error");
  const inbox = palette.getByRole("group", { exact: true, name: "Inbox" });
  const match = inbox.getByRole("option").first();
  await expect(match).toHaveAccessibleName(new RegExp(rollout.title));
  await match.click();
  await expect(page).toHaveURL(/\/\?view=inbox$/);
  await expect(
    page.getByRole("region", { name: /: asks$/ }).filter({
      hasText: rollout.title,
    }),
  ).toBeVisible();
});

test("a snoozed match opens Snoozed with its row expanded", async ({
  dashboard,
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await mockReviewItems(page, { open: [rollout] });
  await page.goto(dashboard.baseURL);
  await page
    .getByRole("button", { name: "Show asks in Investigate checkout latency" })
    .click();
  await page.getByRole("button", { name: "Snooze" }).click();
  await page.getByRole("button", { name: "Tomorrow" }).click();
  await expect(
    page
      .getByRole("region", { name: "To do" })
      .getByRole("link", { name: /Investigate checkout latency/ }),
  ).toHaveCount(0);

  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("canary error");
  await palette
    .getByRole("group", { exact: true, name: "Inbox" })
    .getByRole("option", { name: new RegExp(rollout.title) })
    .click();
  await expect(page).toHaveURL(/\/\?view=snoozed$/);
  const asks = page.getByRole("region", { name: /: asks$/ });
  await expect(asks).toContainText(rollout.title);
  // It wakes from the open row.
  await asks.getByRole("button", { name: "Wake" }).click();
  await expect(page.getByText("Nothing snoozed")).toBeVisible();
});

test("searches the directory pages, with the page's group first", async ({
  context,
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const firstMatch = async (
    path: string,
    query: string,
    group: string,
    name: RegExp,
  ) => {
    await page.goto(`${dashboard.baseURL}${path}`);
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("combobox").fill(query);
    const first = palette.getByRole("group").first();
    await expect(first).toHaveAccessibleName(group);
    const match = first.getByRole("option").first();
    await expect(match).toHaveAccessibleName(name);
    return match;
  };

  await (
    await firstMatch("/system/people", "avery", "People", /Avery Example/)
  ).click();
  await expect(page).toHaveURL(/\/people\/avery%40example\.com$/);

  await (
    await firstMatch(
      "/system/locations",
      "checkout",
      "Locations",
      /#proj-checkout/,
    )
  ).click();
  await expect(page).toHaveURL(/\/system\/locations\/mock%3ACQA123$/);

  await (
    await firstMatch("/code", "junior", "Repositories", /getsentry\/junior/)
  ).click();
  await expect(
    page.getByRole("heading", { name: "getsentry/junior", exact: true }),
  ).toBeVisible();

  // On a repository, its changes lead, and one opens on its provider.
  await context.route("https://github.com/**", (route) =>
    route.fulfill({ body: "" }),
  );
  const change = await firstMatch(
    new URL(page.url()).pathname,
    "repository context",
    "Changes",
    /Keep repository context across turns/,
  );
  const opened = context.waitForEvent("page");
  await change.click();
  await expect(await opened).toHaveURL(
    "https://github.com/getsentry/junior/pull/781",
  );

  await (
    await firstMatch("/automations/runs", "weekly", "Runs", /Weekly project/)
  ).click();
  await expect(page).toHaveURL(/\/automations\/runs\?run=/);
  // The run opens in the conversation drawer, named by its Automation.
  await expect(
    page.getByRole("dialog", { name: "Weekly project summary" }),
  ).toBeVisible();
});

test("closed Inbox matches show under Done, after the open ones", async ({
  page,
  dashboard,
}) => {
  await mockReviewItems(page);
  await page.goto(dashboard.baseURL);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  await palette.getByRole("combobox").fill("license entry");
  const groups = palette.getByRole("group");
  await expect(groups.nth(0)).toHaveAccessibleName("Inbox");
  await expect(groups.nth(1)).toHaveAccessibleName("Done");
  const closed = groups.nth(1).getByRole("option").first();
  await expect(closed).toHaveAccessibleName(/initech license entry/);
  await closed.click();
  // Done opens with the item's row expanded.
  await expect(page).toHaveURL(/\/\?view=done$/);
  await expect(
    page.getByRole("region", {
      name: "Review the initech license entry: how it closed",
    }),
  ).toBeVisible();
});

test("waits for every server search before it says nothing matches", async ({
  page,
  dashboard,
}) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/user-pages/memory/memories?q=*", async (route) => {
    await released;
    await route.fallback();
  });
  await page.goto(dashboard.baseURL);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  const conversationsSearched = page.waitForResponse((response) =>
    response.url().includes("/api/conversations?q="),
  );
  await palette.getByRole("combobox").fill("zzqx nothing");
  // The conversation search has answered; Memories still reads.
  await conversationsSearched;
  await expect(palette.getByText("Searching…")).toBeVisible();
  await expect(palette.getByText("No matches.")).toHaveCount(0);
  // The mock memories ignore the text, so the server's matches then show.
  release();
  await expect(
    palette.getByRole("group", { name: "Memories" }).getByRole("option"),
  ).not.toHaveCount(0);
  await expect(palette.getByText("Searching…")).toHaveCount(0);
});

test("lists the open repository's matching conversations first", async ({
  page,
  dashboard,
}) => {
  await page.goto(
    `${dashboard.baseURL}/code/00000000-0000-4000-8000-000000000003`,
  );
  await expect(
    page.getByRole("heading", { name: "getsentry/junior", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  // "Investigate checkout latency" matches the title better, but it has no
  // change in this repository.
  await palette.getByRole("combobox").fill("ate");
  const conversations = palette.getByRole("group", { name: "Conversations" });
  await expect(conversations.getByRole("option").first()).toHaveAccessibleName(
    /Package release and self-update/,
  );
  await expect(
    conversations.getByRole("option", { name: /Investigate checkout latency/ }),
  ).toBeVisible();
});

test("searches a plugin page from the palette, with its group first", async ({
  page,
  dashboard,
}) => {
  await page.route("**/api/user-pages", (route) =>
    route.fulfill({
      json: [
        {
          description: "Deploy checklists that a fixture plugin owns.",
          id: "checklists",
          label: "Checklists",
          navigation: "profile",
          pluginDisplayName: "Fixture",
          pluginName: "fixture",
        },
      ],
    }),
  );
  const checklists = Array.from({ length: 24 }, (_, index) => ({
    id: `checklist-${index + 1}`,
    title:
      index === 20
        ? "Deploy the payments service"
        : `Routine checklist ${index + 1}`,
  }));
  const queries: string[] = [];
  await page.route("**/api/user-pages/fixture/checklists*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    queries.push(query);
    return route.fulfill({
      json: {
        records: checklists.filter((record) =>
          record.title.toLowerCase().includes(query.toLowerCase()),
        ),
        searchPlaceholder: "Search checklists",
        type: "list",
      },
    });
  });

  await page.setViewportSize({ height: 700, width: 1280 });
  await page.goto(`${dashboard.baseURL}/plugins/fixture/checklists`);
  await expect(
    page.getByRole("heading", { name: "Routine checklist 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Go to conversation" });
  // "Deployment investigation failed" is a Conversation match too.
  await palette.getByRole("combobox").fill("deploy");
  const first = palette.getByRole("group").first();
  await expect(first).toHaveAccessibleName("Checklists");
  await expect(
    palette.getByRole("group", { name: "Conversations" }),
  ).toBeVisible();
  const match = first.getByRole("option").first();
  await expect(match).toHaveAccessibleName(/Deploy the payments service/);
  expect(queries).toContain("deploy");

  await match.click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/plugins/fixture/checklists#record-checklist-21`,
  );
  const record = page.locator("#record-checklist-21");
  await expect(record).toHaveAttribute("aria-current", "true");
  await expect(record).toBeInViewport();
});
